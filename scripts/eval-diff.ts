#!/usr/bin/env npx tsx
/**
 * Compare two evaluation runs to see what changed.
 *
 * Usage:
 *   npx tsx scripts/eval-diff.ts <old-results.md> <new-results.md>
 *   npx tsx scripts/eval-diff.ts  # Compare last two runs (if archived)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ParsedResult {
  caseId: string;
  expected: string;
  got: string;
  actionMatch: boolean;
}

function parseResultsFile(content: string): Map<string, ParsedResult> {
  const results = new Map<string, ParsedResult>();

  // Parse the markdown table
  const lines = content.split('\n');
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('| Case ID |')) {
      inTable = true;
      continue;
    }
    if (line.startsWith('|---')) continue;
    if (!inTable) continue;
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }

    const cols = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cols.length < 4) continue;

    const [caseId, expected, got, actionIcon] = cols;
    results.set(caseId, {
      caseId,
      expected,
      got,
      actionMatch: actionIcon === '✅',
    });
  }

  return results;
}

function main(): void {
  let oldPath = process.argv[2];
  let newPath = process.argv[3];

  const archiveDir = join(__dirname, '..', 'test-data', 'eval-archive');

  // If no args, try to find last two archived results
  if (!oldPath && !newPath) {
    if (existsSync(archiveDir)) {
      const files = readdirSync(archiveDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse();

      if (files.length >= 2) {
        newPath = join(archiveDir, files[0]);
        oldPath = join(archiveDir, files[1]);
        console.log(`Comparing archived results:`);
        console.log(`  Old: ${files[1]}`);
        console.log(`  New: ${files[0]}`);
      }
    }
  }

  if (!oldPath || !newPath) {
    console.log('Usage: npx tsx scripts/eval-diff.ts <old-results.md> <new-results.md>');
    console.log('\nOr archive results and run without args to compare last two runs.');
    process.exit(1);
  }

  if (!existsSync(oldPath)) {
    console.error(`File not found: ${oldPath}`);
    process.exit(1);
  }
  if (!existsSync(newPath)) {
    console.error(`File not found: ${newPath}`);
    process.exit(1);
  }

  const oldResults = parseResultsFile(readFileSync(oldPath, 'utf8'));
  const newResults = parseResultsFile(readFileSync(newPath, 'utf8'));

  console.log('\n=== Evaluation Diff ===\n');

  // Find improvements
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  const newCases: string[] = [];

  for (const [caseId, newResult] of newResults) {
    const oldResult = oldResults.get(caseId);

    if (!oldResult) {
      newCases.push(caseId);
      continue;
    }

    if (oldResult.actionMatch === newResult.actionMatch) {
      unchanged.push(caseId);
    } else if (newResult.actionMatch && !oldResult.actionMatch) {
      improved.push(caseId);
    } else {
      regressed.push(caseId);
    }
  }

  // Summary
  const oldCorrect = [...oldResults.values()].filter((r) => r.actionMatch).length;
  const newCorrect = [...newResults.values()].filter((r) => r.actionMatch).length;

  console.log(`Old accuracy: ${oldCorrect}/${oldResults.size} (${Math.round((oldCorrect / oldResults.size) * 100)}%)`);
  console.log(`New accuracy: ${newCorrect}/${newResults.size} (${Math.round((newCorrect / newResults.size) * 100)}%)`);
  console.log();

  if (improved.length > 0) {
    console.log(`✅ Improved (${improved.length}):`);
    for (const caseId of improved) {
      const old = oldResults.get(caseId)!;
      const curr = newResults.get(caseId)!;
      console.log(`   ${caseId}: ${old.expected} → was ${old.got}, now ${curr.got}`);
    }
    console.log();
  }

  if (regressed.length > 0) {
    console.log(`❌ Regressed (${regressed.length}):`);
    for (const caseId of regressed) {
      const old = oldResults.get(caseId)!;
      const curr = newResults.get(caseId)!;
      console.log(`   ${caseId}: ${old.expected} → was ${old.got} ✓, now ${curr.got} ✗`);
    }
    console.log();
  }

  if (newCases.length > 0) {
    console.log(`🆕 New cases (${newCases.length}):`);
    for (const caseId of newCases) {
      const curr = newResults.get(caseId)!;
      console.log(`   ${caseId}: ${curr.actionMatch ? '✅' : '❌'} ${curr.expected} → ${curr.got}`);
    }
    console.log();
  }

  const delta = newCorrect - oldCorrect;
  if (delta > 0) {
    console.log(`📈 Net improvement: +${delta} cases`);
  } else if (delta < 0) {
    console.log(`📉 Net regression: ${delta} cases`);
  } else {
    console.log(`➡️  No change in accuracy`);
  }
}

main();
