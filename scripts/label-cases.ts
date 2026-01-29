#!/usr/bin/env npx tsx
/**
 * Interactive tool to label test cases.
 *
 * Usage:
 *   npx tsx scripts/label-cases.ts              # Label unlabeled cases
 *   npx tsx scripts/label-cases.ts --all        # Review all cases
 *   npx tsx scripts/label-cases.ts --id <id>    # Label specific case
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';

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

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function labelCase(testCase: TestCase): Promise<boolean> {
  console.log('\n' + '='.repeat(70));
  console.log(`ID: ${testCase.id}`);
  console.log(`Source: ${testCase.source}`);
  console.log(`Date: ${testCase.date ?? 'N/A'}`);
  console.log(`Reporter: ${testCase.reporter}`);
  console.log('-'.repeat(70));
  console.log(testCase.message);
  console.log('-'.repeat(70));

  if (testCase.expected.action) {
    console.log(`Current label: ${testCase.expected.action}${testCase.expected.team ? ` (${testCase.expected.team})` : ''}`);
    console.log(`Notes: ${testCase.expected.notes ?? ''}`);
  }

  console.log('\nActions:');
  console.log('  1. existing_ticket  - Duplicate/related to existing issue');
  console.log('  2. new_bug          - Genuine new bug');
  console.log('  3. not_a_bug        - Feature request, support question, user error');
  console.log('  4. needs_info       - Cannot determine without more info');
  console.log('  s. skip             - Skip this case');
  console.log('  q. quit             - Save and exit');

  const actionInput = await prompt('\nAction [1-4/s/q]: ');

  if (actionInput.toLowerCase() === 'q') {
    return false; // Signal to quit
  }

  if (actionInput.toLowerCase() === 's') {
    return true; // Continue to next
  }

  const actionMap: Record<string, TestCase['expected']['action']> = {
    '1': 'existing_ticket',
    '2': 'new_bug',
    '3': 'not_a_bug',
    '4': 'needs_info',
  };

  const action = actionMap[actionInput];
  if (!action) {
    console.log('Invalid input, skipping...');
    return true;
  }

  testCase.expected.action = action;

  // Ask for team if new_bug
  if (action === 'new_bug') {
    console.log('\nTeams:');
    console.log('  1. platform    - Infrastructure, auth, performance');
    console.log('  2. enterprise  - Academies, cohorts, admin, B2B');
    console.log('  3. ai          - AI features, Futura, learning tracks');
    console.log('  4. data        - dbt, BigQuery, ThoughtSpot, analytics');

    const teamInput = await prompt('Team [1-4]: ');
    const teamMap: Record<string, TestCase['expected']['team']> = {
      '1': 'platform',
      '2': 'enterprise',
      '3': 'ai',
      '4': 'data',
    };
    testCase.expected.team = teamMap[teamInput] ?? null;
  } else {
    testCase.expected.team = null;
  }

  // Ask for notes
  const notes = await prompt('Notes (optional): ');
  testCase.expected.notes = notes || undefined;

  console.log(`\n✓ Labeled: ${action}${testCase.expected.team ? ` (${testCase.expected.team})` : ''}`);

  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const specificId = args.find((a, i) => args[i - 1] === '--id');

  const casesPath = join(__dirname, '..', 'test-data', 'test-cases.json');
  const testFile: TestCasesFile = JSON.parse(readFileSync(casesPath, 'utf8'));

  let cases = testFile.cases;

  if (specificId) {
    cases = cases.filter((c) => c.id === specificId);
    if (cases.length === 0) {
      console.error(`Case not found: ${specificId}`);
      process.exit(1);
    }
  } else if (!showAll) {
    cases = cases.filter((c) => c.expected.action === null);
  }

  console.log('=== Test Case Labeler ===');
  console.log(`Cases to label: ${cases.length}`);

  let labeled = 0;

  for (const testCase of cases) {
    const shouldContinue = await labelCase(testCase);
    if (!shouldContinue) {
      break;
    }
    if (testCase.expected.action !== null) {
      labeled++;
    }
  }

  // Save
  testFile.generated = new Date().toISOString();
  writeFileSync(casesPath, JSON.stringify(testFile, null, 2));

  console.log(`\n✓ Saved. Labeled ${labeled} cases this session.`);

  const totalLabeled = testFile.cases.filter((c) => c.expected.action !== null).length;
  console.log(`Total labeled: ${totalLabeled}/${testFile.cases.length}`);

  rl.close();
}

main().catch((err) => {
  console.error('Error:', err);
  rl.close();
  process.exit(1);
});
