#!/usr/bin/env npx tsx
/**
 * Generate a confidence calibration report.
 *
 * Analyzes whether the bot's confidence levels correlate with actual accuracy.
 *
 * Usage:
 *   npx tsx scripts/calibration-report.ts [options]
 *
 * Options:
 *   --output <file>   Output file (default: stdout)
 */

import { writeFileSync } from 'node:fs';
import { FeedbackManager } from '../src/feedback.js';

interface ConfidenceStats {
  total: number;
  correct: number;
  incorrect: number;
  pending: number;
  accuracy: number;
}

function parseArgs(): {
  output: string | undefined;
} {
  const args = process.argv.slice(2);
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      output = args[++i];
    }
  }

  return { output };
}

function main(): void {
  const opts = parseArgs();

  console.log('Confidence Calibration Report');
  console.log('=============================\n');

  const feedback = new FeedbackManager();
  const logs = feedback.getAllLogs();

  if (logs.length === 0) {
    console.log('No decision history found.');
    console.log('Run the triage bot to generate history.');
    return;
  }

  // Group by confidence level
  const byConfidence: Record<string, ConfidenceStats> = {
    high: { total: 0, correct: 0, incorrect: 0, pending: 0, accuracy: 0 },
    medium: { total: 0, correct: 0, incorrect: 0, pending: 0, accuracy: 0 },
    low: { total: 0, correct: 0, incorrect: 0, pending: 0, accuracy: 0 },
  };

  for (const log of logs) {
    const conf = log.decision.confidence;
    const stats = byConfidence[conf];
    if (!stats) continue;

    stats.total++;
    if (log.wasCorrect === true) {
      stats.correct++;
    } else if (log.wasCorrect === false) {
      stats.incorrect++;
    } else {
      stats.pending++;
    }
  }

  // Calculate accuracy
  for (const stats of Object.values(byConfidence)) {
    const evaluated = stats.correct + stats.incorrect;
    stats.accuracy = evaluated > 0 ? stats.correct / evaluated : 0;
  }

  // Generate report
  let report = `# Confidence Calibration Report

**Generated:** ${new Date().toISOString()}
**Total decisions:** ${logs.length}
**Evaluated:** ${logs.filter(l => l.wasCorrect !== null).length}

## Calibration by Confidence Level

| Confidence | Total | Correct | Incorrect | Pending | Accuracy | Target |
|------------|-------|---------|-----------|---------|----------|--------|
`;

  const targets = { high: 0.9, medium: 0.7, low: 0.5 };

  for (const [level, stats] of Object.entries(byConfidence)) {
    const target = targets[level as keyof typeof targets];
    const accuracyPct = (stats.accuracy * 100).toFixed(1);
    const targetPct = (target * 100).toFixed(0);
    const calibrated = stats.accuracy >= target ? '✅' : '⚠️';

    report += `| ${level} | ${stats.total} | ${stats.correct} | ${stats.incorrect} | ${stats.pending} | ${accuracyPct}% ${calibrated} | ${targetPct}%+ |\n`;
  }

  // Calibration assessment
  report += `\n## Assessment\n\n`;

  const highCalibrated = byConfidence.high.accuracy >= targets.high;
  const mediumCalibrated = byConfidence.medium.accuracy >= targets.medium;
  const lowCalibrated = byConfidence.low.accuracy >= targets.low;

  if (highCalibrated && mediumCalibrated) {
    report += `✅ **Well calibrated:** Confidence levels correlate with accuracy.\n\n`;
  } else {
    if (!highCalibrated && byConfidence.high.total > 5) {
      report += `⚠️  **High confidence under-calibrated:** ${(byConfidence.high.accuracy * 100).toFixed(1)}% accuracy (target: 90%+)\n`;
      report += `    - Consider tightening criteria for high confidence decisions\n`;
      report += `    - Or use --min-confidence medium in production\n\n`;
    }
    if (!mediumCalibrated && byConfidence.medium.total > 5) {
      report += `⚠️  **Medium confidence under-calibrated:** ${(byConfidence.medium.accuracy * 100).toFixed(1)}% accuracy (target: 70%+)\n`;
      report += `    - Consider more conservative defer behavior\n\n`;
    }
    if (!lowCalibrated && byConfidence.low.total > 5) {
      report += `⚠️  **Low confidence under-calibrated:** ${(byConfidence.low.accuracy * 100).toFixed(1)}% accuracy (target: 50%+)\n`;
      report += `    - Low confidence is performing poorly; these should default to defer\n\n`;
    }
  }

  // Recommendations
  report += `## Recommendations\n\n`;

  // Check if high confidence is being overused
  const highRatio = byConfidence.high.total / logs.length;
  if (highRatio > 0.5 && !highCalibrated) {
    report += `- **Reduce high confidence usage:** ${(highRatio * 100).toFixed(0)}% of decisions are high confidence, but accuracy is ${(byConfidence.high.accuracy * 100).toFixed(0)}%.\n`;
  }

  // Check for insufficient data
  const totalEvaluated = logs.filter(l => l.wasCorrect !== null).length;
  if (totalEvaluated < 30) {
    report += `- **Insufficient data:** Only ${totalEvaluated} decisions have been evaluated. Need 30+ for reliable calibration.\n`;
  }

  // Action distribution
  report += `\n## Action Distribution\n\n`;
  const actionCounts = new Map<string, number>();
  for (const log of logs) {
    const action = log.decision.action;
    actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
  }

  report += `| Action | Count | % |\n`;
  report += `|--------|-------|---|\n`;

  for (const [action, count] of [...actionCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / logs.length) * 100).toFixed(1);
    report += `| ${action} | ${count} | ${pct}% |\n`;
  }

  // Output
  if (opts.output) {
    writeFileSync(opts.output, report);
    console.log(`Report written to ${opts.output}`);
  } else {
    console.log(report);
  }
}

main();
