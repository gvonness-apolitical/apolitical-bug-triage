#!/usr/bin/env npx tsx
/**
 * Refresh historical messages while preserving existing labels.
 *
 * This fetches new messages from #bug-hunt and merges them into
 * test-cases.json without overwriting existing labels.
 *
 * Usage:
 *   npx tsx scripts/refresh-historical.ts [--limit 100]
 */

import { WebClient } from '@slack/web-api';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCredential } from '../src/keychain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TestCase {
  id: string;
  source: 'historical' | 'synthetic';
  message: string;
  reporter: string;
  date?: string;
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

async function main(): Promise<void> {
  const limit = parseInt(
    process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '100',
    10
  );

  console.log('=== Refresh Historical Messages ===');
  console.log(`Fetching up to ${limit} messages from #bug-hunt...`);

  const client = new WebClient(requireCredential('SLACK_TOKEN'));
  const channelId = 'C3W35V43D'; // #bug-hunt

  const result = await client.conversations.history({
    channel: channelId,
    limit,
  });

  // Load existing test cases
  const casesPath = join(__dirname, '..', 'test-data', 'test-cases.json');
  let testFile: TestCasesFile;

  if (existsSync(casesPath)) {
    testFile = JSON.parse(readFileSync(casesPath, 'utf8'));
    console.log(`Loaded ${testFile.cases.length} existing cases.`);
  } else {
    testFile = { generated: new Date().toISOString(), cases: [] };
    console.log('No existing test cases file.');
  }

  // Build lookup of existing cases by ID
  const existingById = new Map(testFile.cases.map((c) => [c.id, c]));

  let added = 0;
  let updated = 0;

  for (const msg of result.messages ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = msg as any;
    if (m.subtype || !m.text || !m.ts) continue;

    const id = `hist-${m.ts}`;
    const existing = existingById.get(id);

    if (existing) {
      // Update message text but preserve labels
      if (existing.message !== m.text) {
        existing.message = m.text;
        updated++;
      }
    } else {
      // Add new case
      const newCase: TestCase = {
        id,
        source: 'historical',
        message: m.text,
        reporter: m.user ?? 'unknown',
        date: new Date(parseFloat(m.ts) * 1000).toISOString(),
        mockLinearResults: [],
        expected: {
          action: null,
          team: null,
          confidence: null,
          notes: 'TODO: Fill in expected outcome',
        },
      };
      testFile.cases.push(newCase);
      existingById.set(id, newCase);
      added++;
    }
  }

  // Sort by date (newest first)
  testFile.cases.sort((a, b) => {
    const aDate = a.date ?? '';
    const bDate = b.date ?? '';
    return bDate.localeCompare(aDate);
  });

  testFile.generated = new Date().toISOString();
  writeFileSync(casesPath, JSON.stringify(testFile, null, 2));

  console.log(`\n✓ Done.`);
  console.log(`  Added: ${added} new cases`);
  console.log(`  Updated: ${updated} existing cases`);
  console.log(`  Total: ${testFile.cases.length} cases`);

  const labeled = testFile.cases.filter((c) => c.expected.action !== null).length;
  console.log(`  Labeled: ${labeled}/${testFile.cases.length}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
