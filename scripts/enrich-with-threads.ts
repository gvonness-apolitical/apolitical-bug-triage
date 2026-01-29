#!/usr/bin/env npx tsx
/**
 * Enrich test cases with thread replies from Slack.
 *
 * This fetches the thread replies for each historical message,
 * which helps with labeling (seeing how the issue was resolved)
 * and could inform prompt improvements.
 *
 * Usage:
 *   npx tsx scripts/enrich-with-threads.ts [--limit 20]
 */

import { WebClient } from '@slack/web-api';
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limit = parseInt(
    args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '50',
    10
  );
  const forceRefresh = args.includes('--force');

  console.log('=== Enrich Test Cases with Thread Replies ===\n');

  const casesPath = join(__dirname, '..', 'test-data', 'test-cases.json');
  if (!existsSync(casesPath)) {
    console.error('test-cases.json not found. Run eval:generate first.');
    process.exit(1);
  }

  const testFile: TestCasesFile = JSON.parse(readFileSync(casesPath, 'utf8'));
  const client = new WebClient(requireCredential('SLACK_TOKEN'));
  const channelId = 'C3W35V43D'; // #bug-hunt

  // Filter to historical cases that need enrichment
  let toEnrich = testFile.cases.filter(
    (c) => c.source === 'historical' && (forceRefresh || !c.threadReplies)
  );

  if (limit > 0) {
    toEnrich = toEnrich.slice(0, limit);
  }

  console.log(`Cases to enrich: ${toEnrich.length}`);
  if (!forceRefresh) {
    console.log('(Use --force to re-fetch already enriched cases)\n');
  }

  let enriched = 0;
  let withReplies = 0;

  for (let i = 0; i < toEnrich.length; i++) {
    const testCase = toEnrich[i];
    const ts = testCase.id.replace('hist-', '');

    process.stdout.write(`[${i + 1}/${toEnrich.length}] ${testCase.id}... `);

    try {
      const result = await client.conversations.replies({
        channel: channelId,
        ts: ts,
        limit: 50,
      });

      const messages = result.messages ?? [];

      // First message is the original, rest are replies
      const replies: ThreadReply[] = [];
      for (let j = 1; j < messages.length; j++) {
        const msg = messages[j];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = msg as any;
        if (!m.text || !m.ts) continue;

        replies.push({
          ts: m.ts,
          user: m.user ?? 'unknown',
          text: m.text,
          isBot: Boolean(m.bot_id || m.subtype === 'bot_message'),
        });
      }

      testCase.threadReplies = replies;

      if (replies.length > 0) {
        withReplies++;
        console.log(`${replies.length} replies`);
      } else {
        console.log('no replies');
      }

      enriched++;

      // Rate limiting - Slack allows ~50 req/min for this endpoint
      await sleep(100);
    } catch (err) {
      console.log(`error: ${err}`);
    }
  }

  // Save
  testFile.generated = new Date().toISOString();
  writeFileSync(casesPath, JSON.stringify(testFile, null, 2));

  console.log(`\n✓ Done.`);
  console.log(`  Enriched: ${enriched} cases`);
  console.log(`  With replies: ${withReplies} cases`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
