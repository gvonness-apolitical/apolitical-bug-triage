#!/usr/bin/env npx tsx
/**
 * Export historical messages from #bug-hunt for test case generation.
 *
 * Usage:
 *   npx tsx scripts/export-historical.ts [--limit 100]
 */

import { WebClient } from '@slack/web-api';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCredential } from '../src/keychain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ExportedMessage {
  ts: string;
  text: string;
  user: string;
  date: string;
}

async function main(): Promise<void> {
  const limit = parseInt(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '100', 10);

  console.log(`Exporting up to ${limit} messages from #bug-hunt...`);

  const client = new WebClient(requireCredential('SLACK_TOKEN'));
  const channelId = 'C3W35V43D'; // #bug-hunt

  const result = await client.conversations.history({
    channel: channelId,
    limit,
  });

  const messages: ExportedMessage[] = [];

  for (const msg of result.messages ?? []) {
    // Skip bot messages, join/leave, etc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = msg as any;
    if (m.subtype || !m.text || !m.ts) continue;

    messages.push({
      ts: m.ts,
      text: m.text,
      user: m.user ?? 'unknown',
      date: new Date(parseFloat(m.ts) * 1000).toISOString(),
    });
  }

  const outputPath = join(__dirname, '..', 'test-data', 'historical-messages.json');
  writeFileSync(outputPath, JSON.stringify(messages, null, 2));

  console.log(`Exported ${messages.length} messages to test-data/historical-messages.json`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
