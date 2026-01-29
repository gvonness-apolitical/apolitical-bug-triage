#!/usr/bin/env npx tsx
/**
 * Analyze thread replies to suggest labels for test cases.
 *
 * This uses heuristics to detect patterns in thread replies that
 * indicate the outcome (e.g., "duplicate of X", "created ticket Y",
 * "not a bug", etc.).
 *
 * Usage:
 *   npx tsx scripts/analyze-threads.ts [--apply]
 *
 * Without --apply, it just shows suggestions. With --apply, it
 * updates cases that have high-confidence suggestions.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ThreadReply {
  ts: string;
  user: string;
  text: string;
  isBot: boolean;
}

interface TestCase {
  id: string;
  source: 'historical' | 'synthetic';
  message: string;
  reporter: string;
  date?: string;
  threadReplies?: ThreadReply[];
  threadSummary?: string;
  mockLinearResults?: Array<{
    identifier: string;
    title: string;
    state: string;
    team: string;
    url: string;
  }>;
  expected: {
    action: 'existing_ticket' | 'new_bug' | 'not_a_bug' | 'needs_info' | null;
    team?: 'platform' | 'enterprise' | 'ai' | 'data' | null;
    confidence?: 'high' | 'medium' | 'low' | null;
    notes?: string;
  };
}

interface TestCasesFile {
  generated: string;
  cases: TestCase[];
}

interface Suggestion {
  action: TestCase['expected']['action'];
  team?: TestCase['expected']['team'];
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  ticketRef?: string;
}

// Patterns to detect outcomes
const patterns = {
  // Existing ticket patterns
  existingTicket: [
    /(?:duplicate|dupe|already (?:tracked|exists|reported|filed))/i,
    /(?:same as|related to|see)\s+(?:APO|PLA|ENT|DAT|AI)-\d+/i,
    /linear\.app\/apolitical\/issue\/(APO|PLA|ENT|DAT|AI)-\d+/i,
    /this is (?:tracked|covered) (?:in|by)/i,
  ],

  // New ticket created patterns
  newTicket: [
    /(?:created|filed|opened|raised)\s+(?:a\s+)?(?:ticket|issue|bug)/i,
    /(?:APO|PLA|ENT|DAT|AI)-\d+\s+(?:created|opened)/i,
    /I(?:'ve|'ll| have| will)\s+(?:create|file|open|raise)/i,
    /ticket\s+(?:created|raised|filed)/i,
  ],

  // Not a bug patterns
  notABug: [
    /(?:not a bug|isn't a bug|this is expected|by design|working as intended)/i,
    /(?:feature request|enhancement|improvement)/i,
    /(?:user error|user mistake|PEBKAC)/i,
    /(?:support question|how do I|documentation)/i,
    /(?:won't fix|wontfix|not going to fix)/i,
    /(?:this is normal|expected behavior)/i,
  ],

  // Needs more info patterns
  needsInfo: [
    /(?:can you (?:provide|share|send)|need more (?:info|details|context))/i,
    /(?:what (?:browser|device|version)|which (?:page|screen|user))/i,
    /(?:steps to reproduce|how to reproduce|repro steps)/i,
    /(?:screenshot|screen recording|video)/i,
    /(?:can you clarify|could you explain)/i,
  ],

  // Resolution patterns (to detect if issue was resolved)
  resolved: [
    /(?:fixed|resolved|deployed|released|shipped)/i,
    /(?:this (?:is|should be) (?:fixed|resolved|working) now)/i,
    /(?:pushed a fix|merged|PR merged)/i,
  ],

  // Ticket reference extraction
  ticketRef: /(APO|PLA|ENT|DAT|AI)-\d+/gi,
};

function analyzeThread(testCase: TestCase): Suggestion | null {
  if (!testCase.threadReplies || testCase.threadReplies.length === 0) {
    return null;
  }

  const allText = testCase.threadReplies.map((r) => r.text).join('\n');
  const botReplies = testCase.threadReplies.filter((r) => r.isBot);
  const humanReplies = testCase.threadReplies.filter((r) => !r.isBot);

  // Extract any ticket references
  const ticketRefs = allText.match(patterns.ticketRef) ?? [];
  const uniqueTickets = [...new Set(ticketRefs.map((t) => t.toUpperCase()))];

  // Check for existing ticket signals
  for (const pattern of patterns.existingTicket) {
    if (pattern.test(allText)) {
      return {
        action: 'existing_ticket',
        confidence: uniqueTickets.length > 0 ? 'high' : 'medium',
        reason: `Thread indicates duplicate/existing issue${uniqueTickets.length > 0 ? `: ${uniqueTickets[0]}` : ''}`,
        ticketRef: uniqueTickets[0],
      };
    }
  }

  // Check for new ticket created
  for (const pattern of patterns.newTicket) {
    if (pattern.test(allText)) {
      // Try to detect team from ticket prefix
      let team: TestCase['expected']['team'] = null;
      if (uniqueTickets.length > 0) {
        const prefix = uniqueTickets[0].split('-')[0];
        const teamMap: Record<string, TestCase['expected']['team']> = {
          PLA: 'platform',
          ENT: 'enterprise',
          AI: 'ai',
          DAT: 'data',
        };
        team = teamMap[prefix] ?? null;
      }

      return {
        action: 'new_bug',
        team,
        confidence: uniqueTickets.length > 0 ? 'high' : 'medium',
        reason: `Thread indicates ticket was created${uniqueTickets.length > 0 ? `: ${uniqueTickets[0]}` : ''}`,
        ticketRef: uniqueTickets[0],
      };
    }
  }

  // Check for not a bug
  for (const pattern of patterns.notABug) {
    if (pattern.test(allText)) {
      return {
        action: 'not_a_bug',
        confidence: 'medium',
        reason: 'Thread indicates this is not a bug (feature request, expected behavior, or user error)',
      };
    }
  }

  // Check for needs info (if no resolution found)
  let needsInfoMatch = false;
  for (const pattern of patterns.needsInfo) {
    if (pattern.test(allText)) {
      needsInfoMatch = true;
      break;
    }
  }

  // Check if resolved despite needing info
  let resolvedMatch = false;
  for (const pattern of patterns.resolved) {
    if (pattern.test(allText)) {
      resolvedMatch = true;
      break;
    }
  }

  if (needsInfoMatch && !resolvedMatch && humanReplies.length <= 2) {
    return {
      action: 'needs_info',
      confidence: 'low',
      reason: 'Thread shows request for more information without clear resolution',
    };
  }

  // If there are ticket references but no clear pattern, suggest existing_ticket
  if (uniqueTickets.length > 0) {
    return {
      action: 'existing_ticket',
      confidence: 'low',
      reason: `Thread references ticket(s): ${uniqueTickets.join(', ')}`,
      ticketRef: uniqueTickets[0],
    };
  }

  return null;
}

function main(): void {
  const args = process.argv.slice(2);
  const shouldApply = args.includes('--apply');
  const showAll = args.includes('--all');

  const casesPath = join(__dirname, '..', 'test-data', 'test-cases.json');
  if (!existsSync(casesPath)) {
    console.error('test-cases.json not found.');
    process.exit(1);
  }

  const testFile: TestCasesFile = JSON.parse(readFileSync(casesPath, 'utf8'));

  console.log('=== Thread Analysis ===\n');

  // Filter to cases with threads
  let cases = testFile.cases.filter(
    (c) => c.threadReplies && c.threadReplies.length > 0
  );

  if (!showAll) {
    // Only unlabeled cases
    cases = cases.filter((c) => c.expected.action === null);
  }

  console.log(`Analyzing ${cases.length} cases with thread replies...\n`);

  const suggestions: Array<{ testCase: TestCase; suggestion: Suggestion }> = [];

  for (const testCase of cases) {
    const suggestion = analyzeThread(testCase);
    if (suggestion) {
      suggestions.push({ testCase, suggestion });
    }
  }

  // Group by confidence
  const highConf = suggestions.filter((s) => s.suggestion.confidence === 'high');
  const medConf = suggestions.filter((s) => s.suggestion.confidence === 'medium');
  const lowConf = suggestions.filter((s) => s.suggestion.confidence === 'low');

  console.log(`Suggestions: ${suggestions.length} total`);
  console.log(`  High confidence: ${highConf.length}`);
  console.log(`  Medium confidence: ${medConf.length}`);
  console.log(`  Low confidence: ${lowConf.length}\n`);

  // Display suggestions
  for (const { testCase, suggestion } of suggestions) {
    const conf = suggestion.confidence === 'high' ? '🟢' : suggestion.confidence === 'medium' ? '🟡' : '🔴';
    console.log(`${conf} ${testCase.id}`);
    console.log(`   Message: ${testCase.message.substring(0, 60)}...`);
    console.log(`   Suggest: ${suggestion.action}${suggestion.team ? ` (${suggestion.team})` : ''}`);
    console.log(`   Reason: ${suggestion.reason}`);
    if (suggestion.ticketRef) {
      console.log(`   Ticket: ${suggestion.ticketRef}`);
    }
    console.log();
  }

  // Apply suggestions if requested
  if (shouldApply) {
    const includeMedium = args.includes('--medium');
    const toApply = includeMedium ? [...highConf, ...medConf] : highConf;
    const confLabel = includeMedium ? 'high and medium' : 'high';

    let applied = 0;
    for (const { testCase, suggestion } of toApply) {
      if (testCase.expected.action === null) {
        testCase.expected.action = suggestion.action;
        testCase.expected.team = suggestion.team ?? null;
        testCase.expected.confidence = suggestion.confidence;
        testCase.expected.notes = `Auto-labeled (${suggestion.confidence}): ${suggestion.reason}`;
        applied++;
      }
    }

    if (applied > 0) {
      testFile.generated = new Date().toISOString();
      writeFileSync(casesPath, JSON.stringify(testFile, null, 2));
      console.log(`\n✓ Applied ${applied} ${confLabel}-confidence suggestions.`);
    } else {
      console.log(`\nNo new labels to apply (${confLabel}-confidence cases may already be labeled).`);
    }
  } else {
    console.log('Run with --apply to auto-label high-confidence suggestions.');
    console.log('Run with --apply --medium to also include medium-confidence.');
  }
}

main();
