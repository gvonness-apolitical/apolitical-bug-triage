#!/usr/bin/env npx tsx
/**
 * Use Claude to analyze threads and suggest labels for test cases.
 *
 * This is more accurate than regex pattern matching because Claude
 * can understand the context and nuance of the conversation.
 *
 * Usage:
 *   npx tsx scripts/claude-label.ts [options]
 *
 * Options:
 *   --limit <n>       Process at most n cases (default: 10)
 *   --apply           Apply suggestions (otherwise just preview)
 *   --model <model>   Model to use (default: claude-sonnet-4-20250514)
 *   --min-replies <n> Only process cases with at least n replies (default: 1)
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCredential } from '../src/keychain.js';

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
  mockLinearResults?: Array<{
    identifier: string;
    title: string;
    state: string;
    team: string;
    url: string;
  }>;
  expected: {
    action: 'existing_ticket' | 'new_bug' | 'not_a_bug' | 'needs_info' | 'defer' | null;
    team?: 'platform' | 'enterprise' | 'ai' | 'data' | null;
    confidence?: 'high' | 'medium' | 'low' | null;
    notes?: string;
  };
}

interface TestCasesFile {
  generated: string;
  cases: TestCase[];
}

interface LabelSuggestion {
  action: 'existing_ticket' | 'new_bug' | 'not_a_bug' | 'needs_info' | 'defer';
  team?: 'platform' | 'enterprise' | 'ai' | 'data';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  ticketRef?: string;
}

function parseArgs(): {
  limit: number;
  apply: boolean;
  model: string;
  minReplies: number;
  relabel: boolean;
} {
  const args = process.argv.slice(2);
  let limit = 10;
  let apply = false;
  let model = 'claude-sonnet-4-20250514';
  let minReplies = 1;
  let relabel = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--apply') {
      apply = true;
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === '--min-replies' && args[i + 1]) {
      minReplies = parseInt(args[++i], 10);
    } else if (args[i] === '--relabel') {
      relabel = true;
    }
  }

  return { limit, apply, model, minReplies, relabel };
}

function buildPrompt(testCase: TestCase): string {
  const replies = testCase.threadReplies ?? [];

  let threadText = '';
  if (replies.length > 0) {
    threadText = replies
      .map((r, i) => {
        const who = r.isBot ? '[BOT]' : `[User ${r.user}]`;
        return `Reply ${i + 1} ${who}:\n${r.text}`;
      })
      .join('\n\n');
  }

  return `You are creating training labels for a bug triage bot. The bot will see ONLY the original message (not the thread replies). You need to determine what action the bot SHOULD take based on what a reasonable triage decision would be.

## Original Bug Report (this is what the bot will see)

**Reporter:** ${testCase.reporter}
**Date:** ${testCase.date ?? 'Unknown'}

**Message:**
${testCase.message}

## Thread Replies (for your context only - the bot won't see these)

${threadText || 'No replies'}

## Your Task

Based on the ORIGINAL MESSAGE ALONE, what should a triage bot do? Use the thread replies to understand what the RIGHT answer turned out to be, but label based on what's reasonable given just the initial message.

### Actions:

1. **new_bug** - The original message clearly describes a technical bug with enough detail:
   - Error messages, broken functionality, unexpected behavior
   - Enough context to create a useful ticket
   - NOT just a question or request for help

2. **existing_ticket** - The message clearly describes something that matches an existing issue
   (Note: bot will have Linear search results to reference)

3. **not_a_bug** - The message is CLEARLY one of:
   - Feature request ("it would be nice if...")
   - Support question ("how do I...")
   - User asking for help with their specific account
   - Something explicitly described as expected behavior

4. **needs_info** - The message is too vague to act on - missing key details

5. **defer** - The message is AMBIGUOUS. Use this when:
   - Could be a bug OR a support issue - can't tell from the message
   - Could be user error OR a real problem
   - The thread shows it needed clarification to resolve
   - A human would need to ask questions to decide

   This is the label for "reasonable to not take action automatically"

If the action is "new_bug", also determine which team should own it:
- **platform**: Infrastructure, auth, performance, databases, deployments
- **enterprise**: Academies, cohorts, admin, B2B, SSO
- **ai**: AI features, Futura, learning tracks, AI feedback
- **data**: dbt, BigQuery, ThoughtSpot, analytics

Respond with ONLY a JSON object (no markdown code blocks):

{
  "action": "existing_ticket" | "new_bug" | "not_a_bug" | "needs_info" | "defer",
  "team": "platform" | "enterprise" | "ai" | "data" | null,
  "confidence": "high" | "medium" | "low",
  "reasoning": "Brief explanation (1-2 sentences)",
  "ticketRef": "APO-123 or null if no ticket mentioned"
}

Key principle: If the thread shows that clarification was needed to resolve this, the label should probably be "defer" or "needs_info" - because the original message alone wasn't enough.`;
}

function parseResponse(text: string): LabelSuggestion | null {
  let jsonStr = text.trim();

  // Remove markdown code blocks if present
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(jsonStr);

    // Validate
    const validActions = ['existing_ticket', 'new_bug', 'not_a_bug', 'needs_info', 'defer'];
    if (!validActions.includes(parsed.action)) {
      return null;
    }

    return {
      action: parsed.action,
      team: parsed.team || undefined,
      confidence: parsed.confidence || 'medium',
      reasoning: parsed.reasoning || '',
      ticketRef: parsed.ticketRef || undefined,
    };
  } catch {
    console.error('Failed to parse response:', text.substring(0, 200));
    return null;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log('=== Claude-Powered Labeling ===');
  console.log(`Model: ${opts.model}`);
  console.log(`Limit: ${opts.limit}`);
  console.log(`Min replies: ${opts.minReplies}`);
  console.log(`Mode: ${opts.apply ? 'APPLY' : 'preview'}${opts.relabel ? ' (RELABEL ALL)' : ''}\n`);

  const casesPath = join(__dirname, '..', 'test-data', 'test-cases.json');
  if (!existsSync(casesPath)) {
    console.error('test-cases.json not found.');
    process.exit(1);
  }

  const testFile: TestCasesFile = JSON.parse(readFileSync(casesPath, 'utf8'));
  const anthropic = new Anthropic({ apiKey: requireCredential('ANTHROPIC_API_KEY') });

  // Filter cases based on options
  let toProcess = testFile.cases.filter((c) => {
    // Must have sufficient replies
    if (!c.threadReplies || c.threadReplies.length < opts.minReplies) {
      return false;
    }
    // If relabeling, include all historical cases (skip synthetic)
    if (opts.relabel) {
      return c.source === 'historical';
    }
    // Otherwise, only unlabeled cases
    return c.expected.action === null;
  });

  toProcess = toProcess.slice(0, opts.limit);

  console.log(`Processing ${toProcess.length} cases...\n`);

  const results: Array<{ testCase: TestCase; suggestion: LabelSuggestion }> = [];

  for (let i = 0; i < toProcess.length; i++) {
    const testCase = toProcess[i];

    process.stdout.write(`[${i + 1}/${toProcess.length}] ${testCase.id}... `);

    try {
      const prompt = buildPrompt(testCase);

      const response = await anthropic.messages.create({
        model: opts.model,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });

      const responseText = response.content[0].type === 'text'
        ? response.content[0].text
        : '';

      const suggestion = parseResponse(responseText);

      if (suggestion) {
        results.push({ testCase, suggestion });

        const icon = suggestion.confidence === 'high' ? '🟢' :
                     suggestion.confidence === 'medium' ? '🟡' : '🔴';
        console.log(`${icon} ${suggestion.action}${suggestion.team ? ` (${suggestion.team})` : ''}`);
        console.log(`      ${suggestion.reasoning}`);
      } else {
        console.log('❌ Failed to parse response');
      }
    } catch (err) {
      console.log(`❌ Error: ${err}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`\nResults: ${results.length} suggestions`);

  // Group by confidence
  const byConf = {
    high: results.filter((r) => r.suggestion.confidence === 'high'),
    medium: results.filter((r) => r.suggestion.confidence === 'medium'),
    low: results.filter((r) => r.suggestion.confidence === 'low'),
  };

  console.log(`  High: ${byConf.high.length}`);
  console.log(`  Medium: ${byConf.medium.length}`);
  console.log(`  Low: ${byConf.low.length}`);

  // Group by action
  const byAction: Record<string, number> = {};
  results.forEach((r) => {
    byAction[r.suggestion.action] = (byAction[r.suggestion.action] || 0) + 1;
  });
  console.log('\nBy action:');
  Object.entries(byAction).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  if (opts.apply) {
    let applied = 0;
    for (const { testCase, suggestion } of results) {
      testCase.expected.action = suggestion.action;
      testCase.expected.team = suggestion.team ?? null;
      testCase.expected.confidence = suggestion.confidence;
      testCase.expected.notes = `Claude-labeled: ${suggestion.reasoning}${suggestion.ticketRef ? ` [${suggestion.ticketRef}]` : ''}`;
      applied++;
    }

    testFile.generated = new Date().toISOString();
    writeFileSync(casesPath, JSON.stringify(testFile, null, 2));
    console.log(`\n✓ Applied ${applied} labels.`);
  } else {
    console.log('\nRun with --apply to save these labels.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
