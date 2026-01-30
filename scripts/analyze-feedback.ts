#!/usr/bin/env npx tsx
/**
 * Analyze feedback patterns from corrections to generate improvement recommendations.
 *
 * Usage:
 *   npx tsx scripts/analyze-feedback.ts [options]
 *
 * Options:
 *   --since <date>    Only analyze corrections since this date (ISO 8601)
 *   --output <file>   Output file (default: stdout)
 */

import { writeFileSync } from 'node:fs';
import { FeedbackManager, analyzePatterns } from '../src/feedback.js';

function parseArgs(): {
  since: string | undefined;
  output: string | undefined;
} {
  const args = process.argv.slice(2);
  let since: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since' && args[i + 1]) {
      since = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i];
    }
  }

  return { since, output };
}

function main(): void {
  const opts = parseArgs();

  console.log('Feedback Analysis');
  console.log('=================\n');

  const feedback = new FeedbackManager();

  // Get accuracy stats
  const stats = feedback.getAccuracyStats();
  console.log('Overall Statistics:');
  console.log(`  Total decisions: ${stats.total}`);
  console.log(`  Correct: ${stats.correct}`);
  console.log(`  Incorrect: ${stats.incorrect}`);
  console.log(`  Pending feedback: ${stats.pending}`);
  console.log(`  Accuracy: ${(stats.accuracy * 100).toFixed(1)}%`);
  console.log();

  // Get corrections
  const corrections = feedback.getCorrections(opts.since);

  if (corrections.length === 0) {
    console.log('No corrections found.');
    if (opts.since) {
      console.log(`  (since ${opts.since})`);
    }
    return;
  }

  console.log(`Found ${corrections.length} corrections to analyze.`);
  console.log();

  // Generate report
  const report = analyzePatterns(corrections);

  if (opts.output) {
    writeFileSync(opts.output, report);
    console.log(`Report written to ${opts.output}`);
  } else {
    console.log(report);
  }

  // Show pattern summary
  const patterns = feedback.getPatternAnalysis();
  console.log('\n=== Quick Summary ===\n');

  const sorted = [...patterns.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [pattern, correctionList] of sorted.slice(0, 5)) {
    console.log(`${pattern}: ${correctionList.length} cases`);

    // Show example
    const example = correctionList[0];
    if (example) {
      const msg = example.messageText.substring(0, 60);
      console.log(`  Example: "${msg}..."`);
      console.log(`  Reason: ${example.humanCorrection.reason || 'Not provided'}`);
    }
    console.log();
  }
}

main();
