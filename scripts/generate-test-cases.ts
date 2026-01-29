#!/usr/bin/env npx tsx
/**
 * Generate test cases from historical messages.
 *
 * This reads historical-messages.json and creates a test-cases.json file
 * with placeholders for expected outcomes that you fill in manually.
 *
 * Usage:
 *   npx tsx scripts/generate-test-cases.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface HistoricalMessage {
  ts: string;
  text: string;
  user: string;
  date: string;
}

interface TestCase {
  id: string;
  source: 'historical' | 'synthetic';
  message: string;
  reporter: string;
  date?: string;
  // Mock Linear search results (empty = no existing issues found)
  mockLinearResults?: Array<{
    identifier: string;
    title: string;
    state: string;
    team: string;
    url: string;
  }>;
  // Expected outcome - fill these in manually
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

function main(): void {
  const historicalPath = join(__dirname, '..', 'test-data', 'historical-messages.json');
  const outputPath = join(__dirname, '..', 'test-data', 'test-cases.json');

  if (!existsSync(historicalPath)) {
    console.error('historical-messages.json not found. Run export-historical.ts first.');
    process.exit(1);
  }

  // Load existing test cases to preserve manual edits
  let existingCases: TestCase[] = [];
  if (existsSync(outputPath)) {
    const existing: TestCasesFile = JSON.parse(readFileSync(outputPath, 'utf8'));
    existingCases = existing.cases;
    console.log(`Found ${existingCases.length} existing test cases.`);
  }

  const historical: HistoricalMessage[] = JSON.parse(readFileSync(historicalPath, 'utf8'));
  console.log(`Processing ${historical.length} historical messages...`);

  const cases: TestCase[] = [];

  for (const msg of historical) {
    // Check if we already have this case
    const existingCase = existingCases.find((c) => c.id === `hist-${msg.ts}`);
    if (existingCase) {
      cases.push(existingCase);
      continue;
    }

    // Create new case with null expected values
    cases.push({
      id: `hist-${msg.ts}`,
      source: 'historical',
      message: msg.text,
      reporter: msg.user,
      date: msg.date,
      mockLinearResults: [], // Will use real Linear search
      expected: {
        action: null,
        team: null,
        confidence: null,
        notes: 'TODO: Fill in expected outcome',
      },
    });
  }

  // Preserve any synthetic cases
  const syntheticCases = existingCases.filter((c) => c.source === 'synthetic');
  cases.push(...syntheticCases.filter((s) => !cases.find((c) => c.id === s.id)));

  const output: TestCasesFile = {
    generated: new Date().toISOString(),
    cases,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Written ${cases.length} test cases to test-data/test-cases.json`);
  console.log('\nNext steps:');
  console.log('1. Review test-cases.json and fill in expected.action, expected.team, etc.');
  console.log('2. Run: npx tsx scripts/evaluate.ts');
}

main();
