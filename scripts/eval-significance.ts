#!/usr/bin/env npx tsx
/**
 * Statistical significance test for A/B prompt comparisons.
 *
 * Uses McNemar's test for paired accuracy comparison.
 *
 * Usage:
 *   npx tsx scripts/eval-significance.ts <results-v1.md> <results-v2.md>
 */

import { readFileSync, existsSync } from 'node:fs';

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

/**
 * McNemar's test for paired nominal data.
 *
 * Tests whether the row and column marginal frequencies are equal
 * (i.e., whether the two classifiers have the same error rate).
 *
 * @returns p-value (two-tailed)
 */
function mcnemarsTest(
  b: number, // v1 wrong, v2 correct
  c: number  // v1 correct, v2 wrong
): { chiSquare: number; pValue: number } {
  // McNemar's chi-square statistic with continuity correction
  if (b + c === 0) {
    return { chiSquare: 0, pValue: 1 };
  }

  const chiSquare = Math.pow(Math.abs(b - c) - 1, 2) / (b + c);

  // Approximate p-value from chi-square distribution with 1 degree of freedom
  // Using the survival function (1 - CDF)
  const pValue = 1 - chiSquareCDF(chiSquare, 1);

  return { chiSquare, pValue };
}

/**
 * Chi-square CDF approximation using the incomplete gamma function.
 */
function chiSquareCDF(x: number, k: number): number {
  if (x < 0) return 0;
  return gammainc(k / 2, x / 2);
}

/**
 * Regularized incomplete gamma function (lower).
 * Uses series expansion for small x, continued fraction for large x.
 */
function gammainc(a: number, x: number): number {
  if (x < 0 || a <= 0) return 0;
  if (x === 0) return 0;

  const eps = 1e-10;
  const maxIterations = 100;

  if (x < a + 1) {
    // Use series expansion
    let sum = 1 / a;
    let term = 1 / a;
    for (let n = 1; n < maxIterations; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < eps * Math.abs(sum)) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  } else {
    // Use continued fraction
    let b = x + 1 - a;
    let c = 1 / 1e-30;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i < maxIterations; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = b + an / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < eps) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  }
}

/**
 * Log gamma function using Lanczos approximation.
 */
function lnGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Calculate 95% confidence interval for the difference in proportions.
 */
function confidenceInterval(
  n: number,  // total cases
  b: number,  // v1 wrong, v2 correct
  c: number   // v1 correct, v2 wrong
): { lower: number; upper: number } {
  // Difference in accuracy
  const diff = (b - c) / n;

  // Standard error using the paired formula
  const se = Math.sqrt((b + c - Math.pow(b - c, 2) / n) / Math.pow(n, 2));

  // 95% CI (z = 1.96)
  const z = 1.96;
  return {
    lower: diff - z * se,
    upper: diff + z * se,
  };
}

function main(): void {
  const v1Path = process.argv[2];
  const v2Path = process.argv[3];

  if (!v1Path || !v2Path) {
    console.log('Usage: npx tsx scripts/eval-significance.ts <results-v1.md> <results-v2.md>');
    console.log('\nCompares two evaluation runs using McNemar\'s test.');
    process.exit(1);
  }

  if (!existsSync(v1Path)) {
    console.error(`File not found: ${v1Path}`);
    process.exit(1);
  }
  if (!existsSync(v2Path)) {
    console.error(`File not found: ${v2Path}`);
    process.exit(1);
  }

  const v1Results = parseResultsFile(readFileSync(v1Path, 'utf8'));
  const v2Results = parseResultsFile(readFileSync(v2Path, 'utf8'));

  console.log('\n=== Statistical Significance Test ===\n');
  console.log(`V1: ${v1Path}`);
  console.log(`V2: ${v2Path}`);
  console.log();

  // Build contingency table
  let a = 0; // Both correct
  let b = 0; // V1 wrong, V2 correct
  let c = 0; // V1 correct, V2 wrong
  let d = 0; // Both wrong

  const commonCases: string[] = [];

  for (const [caseId, v1] of v1Results) {
    const v2 = v2Results.get(caseId);
    if (!v2) continue;

    commonCases.push(caseId);

    if (v1.actionMatch && v2.actionMatch) {
      a++;
    } else if (!v1.actionMatch && v2.actionMatch) {
      b++;
    } else if (v1.actionMatch && !v2.actionMatch) {
      c++;
    } else {
      d++;
    }
  }

  const n = commonCases.length;
  const v1Correct = a + c;
  const v2Correct = a + b;

  console.log('Contingency Table:');
  console.log('                  V2 Correct  V2 Wrong');
  console.log(`  V1 Correct      ${String(a).padStart(6)}      ${String(c).padStart(6)}`);
  console.log(`  V1 Wrong        ${String(b).padStart(6)}      ${String(d).padStart(6)}`);
  console.log();

  console.log(`Common cases: ${n}`);
  console.log(`V1 accuracy: ${v1Correct}/${n} (${((v1Correct / n) * 100).toFixed(1)}%)`);
  console.log(`V2 accuracy: ${v2Correct}/${n} (${((v2Correct / n) * 100).toFixed(1)}%)`);
  console.log();

  // McNemar's test
  const { chiSquare, pValue } = mcnemarsTest(b, c);

  console.log(`McNemar's chi-square: ${chiSquare.toFixed(4)}`);
  console.log(`p-value: ${pValue.toFixed(4)}`);
  console.log();

  // Confidence interval
  const ci = confidenceInterval(n, b, c);
  const diffPct = ((b - c) / n * 100).toFixed(1);
  const ciLowerPct = (ci.lower * 100).toFixed(1);
  const ciUpperPct = (ci.upper * 100).toFixed(1);

  console.log(`Difference (V2 - V1): ${diffPct}%`);
  console.log(`95% CI: [${ciLowerPct}%, ${ciUpperPct}%]`);
  console.log();

  // Interpretation
  console.log('=== Interpretation ===\n');

  if (pValue < 0.05) {
    if (v2Correct > v1Correct) {
      console.log('✅ V2 is SIGNIFICANTLY BETTER than V1 (p < 0.05)');
      console.log('   Safe to deploy the new prompt.');
    } else {
      console.log('⚠️  V2 is SIGNIFICANTLY WORSE than V1 (p < 0.05)');
      console.log('   Do NOT deploy the new prompt.');
    }
  } else {
    console.log('➡️  No statistically significant difference (p >= 0.05)');
    console.log('   The prompts perform similarly. Consider:');
    console.log('   - Running with more test cases');
    console.log('   - Making larger prompt changes');
    console.log('   - Keeping V1 if V2 is more complex');
  }
  console.log();

  // Show cases that changed
  if (b > 0 || c > 0) {
    console.log('=== Cases that Changed ===\n');

    if (b > 0) {
      console.log(`Fixed in V2 (${b}):`);
      for (const caseId of commonCases) {
        const v1 = v1Results.get(caseId)!;
        const v2 = v2Results.get(caseId)!;
        if (!v1.actionMatch && v2.actionMatch) {
          console.log(`  ✅ ${caseId}: ${v1.expected} → was ${v1.got}, now ${v2.got}`);
        }
      }
      console.log();
    }

    if (c > 0) {
      console.log(`Broken in V2 (${c}):`);
      for (const caseId of commonCases) {
        const v1 = v1Results.get(caseId)!;
        const v2 = v2Results.get(caseId)!;
        if (v1.actionMatch && !v2.actionMatch) {
          console.log(`  ❌ ${caseId}: ${v1.expected} → was ${v1.got}, now ${v2.got}`);
        }
      }
      console.log();
    }
  }
}

main();
