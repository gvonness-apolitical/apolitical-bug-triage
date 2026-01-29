#!/usr/bin/env npx tsx
/**
 * Archive the current evaluation results with a timestamp.
 *
 * Usage:
 *   npx tsx scripts/archive-eval.ts [--note "description"]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function main(): void {
  const resultsPath = join(__dirname, '..', 'test-data', 'eval-results.md');
  const archiveDir = join(__dirname, '..', 'test-data', 'eval-archive');

  if (!existsSync(resultsPath)) {
    console.error('No eval-results.md to archive. Run an evaluation first.');
    process.exit(1);
  }

  // Create archive directory
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  // Generate timestamp filename
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Get optional note
  const noteIndex = process.argv.indexOf('--note');
  const note = noteIndex >= 0 ? process.argv[noteIndex + 1] : null;

  const filename = note
    ? `${timestamp}-${note.replace(/\s+/g, '-').toLowerCase()}.md`
    : `${timestamp}.md`;

  const archivePath = join(archiveDir, filename);

  // Read current results to extract summary
  const content = readFileSync(resultsPath, 'utf8');
  const accuracyMatch = content.match(/\*\*Accuracy:\*\* (\d+)\/(\d+)/);
  const modelMatch = content.match(/\*\*Model:\*\* ([^\n]+)/);

  // Copy file
  copyFileSync(resultsPath, archivePath);

  console.log(`✓ Archived to: test-data/eval-archive/${filename}`);
  if (accuracyMatch) {
    console.log(`  Accuracy: ${accuracyMatch[1]}/${accuracyMatch[2]}`);
  }
  if (modelMatch) {
    console.log(`  Model: ${modelMatch[1]}`);
  }
  if (note) {
    console.log(`  Note: ${note}`);
  }
}

main();
