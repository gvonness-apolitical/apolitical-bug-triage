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

interface LabelSuggestion {
  action: 'existing_ticket' | 'new_bug' | 'not_a_bug' | 'needs_info';
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
} {
  const args = process.argv.slice(2);
  let limit = 10;
  let apply = false;
  let model = 'claude-sonnet-4-20250514';
  let minReplies = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--apply') {
      apply = true;
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === '--min-replies' && args[i + 1]) {
      minReplies = parseInt(args[++i], 10);
    }
  }

  return { limit, apply, model, minReplies };
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

  return `You are analyzing a bug report from a Slack channel to determine how it was resolved.

## Original Bug Report

**Reporter:** ${testCase.reporter}
**Date:** ${testCase.date ?? 'Unknown'}

**Message:**
${testCase.message}

## Thread Replies (${replies.length} total)

${threadText || 'No replies'}

## Your Task

Based on the original message AND the thread discussion, determine the outcome of this bug report.

Possible outcomes:
1. **existing_ticket** - The issue was identified as a duplicate or related to an existing Linear ticket
2. **new_bug** - A new Linear ticket was created for this issue
3. **not_a_bug** - The issue was determined to not be a bug (feature request, user error, expected behavior, support question)
4. **needs_info** - More information was requested and the issue remains unresolved

If the outcome is "new_bug", also determine which team should own it:
- **platform**: Infrastructure, auth, performance, databases, deployments
- **enterprise**: Academies, cohorts, admin, B2B, SSO
- **ai**: AI features, Futura, learning tracks, AI feedback
- **data**: dbt, BigQuery, ThoughtSpot, analytics

Respond with ONLY a JSON object (no markdown code blocks):

{
  "action": "existing_ticket" | "new_bug" | "not_a_bug" | "needs_info",
  "team": "platform" | "enterprise" | "ai" | "data" | null,
  "confidence": "high" | "medium" | "low",
  "reasoning": "Brief explanation of why you chose this outcome (1-2 sentences)",
  "ticketRef": "APO-123 or null if no ticket mentioned"
}

Important:
- Look for ticket references (APO-XXX, PLA-XXX, etc.) in the thread
- Look for phrases like "created ticket", "this is tracked in", "duplicate of"
- Look for resolutions like "fixed", "deployed", "not a bug", "expected behavior"
- If the thread shows the issue was resolved but no ticket was explicitly created, use your judgment
- If you're unsure, use "medium" or "low" confidence`;
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
    const validActions = ['existing_ticket', 'new_bug', 'not_a_bug', 'needs_info'];
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
  console.log(`Mode: ${opts.apply ? 'APPLY' : 'preview'}\n`);

  const casesPath = join(__dirname, '..', 'test-data', 'test-cases.json');
  if (!existsSync(casesPath)) {
    console.error('test-cases.json not found.');
    process.exit(1);
  }

  const testFile: TestCasesFile = JSON.parse(readFileSync(casesPath, 'utf8'));
  const anthropic = new Anthropic({ apiKey: requireCredential('ANTHROPIC_API_KEY') });

  // Filter to unlabeled cases with sufficient replies
  let toProcess = testFile.cases.filter(
    (c) =>
      c.expected.action === null &&
      c.threadReplies &&
      c.threadReplies.length >= opts.minReplies
  );

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
