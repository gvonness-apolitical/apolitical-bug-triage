#!/usr/bin/env npx tsx
/**
 * Merge synthetic test cases into the main test-cases.json file.
 *
 * Usage:
 *   npx tsx scripts/merge-synthetic.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

interface SyntheticFile {
  description: string;
  cases: TestCase[];
}

function main(): void {
  const syntheticPath = join(__dirname, '..', 'test-data', 'synthetic-cases.json');
  const testCasesPath = join(__dirname, '..', 'test-data', 'test-cases.json');

  if (!existsSync(syntheticPath)) {
    console.error('synthetic-cases.json not found.');
    process.exit(1);
  }

  const synthetic: SyntheticFile = JSON.parse(readFileSync(syntheticPath, 'utf8'));

  // Load or create test-cases.json
  let testCases: TestCasesFile;
  if (existsSync(testCasesPath)) {
    testCases = JSON.parse(readFileSync(testCasesPath, 'utf8'));
  } else {
    testCases = {
      generated: new Date().toISOString(),
      cases: [],
    };
  }

  // Merge synthetic cases (update existing, add new)
  let added = 0;
  let updated = 0;

  for (const synthCase of synthetic.cases) {
    const existingIndex = testCases.cases.findIndex((c) => c.id === synthCase.id);
    if (existingIndex >= 0) {
      testCases.cases[existingIndex] = synthCase;
      updated++;
    } else {
      testCases.cases.push(synthCase);
      added++;
    }
  }

  testCases.generated = new Date().toISOString();
  writeFileSync(testCasesPath, JSON.stringify(testCases, null, 2));

  console.log(`Merged synthetic cases: ${added} added, ${updated} updated`);
  console.log(`Total cases: ${testCases.cases.length}`);
}

main();
