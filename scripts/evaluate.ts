#!/usr/bin/env npx tsx
/**
 * Evaluate prompt performance against test cases.
 *
 * Usage:
 *   npx tsx scripts/evaluate.ts [options]
 *
 * Options:
 *   --model <model>    Claude model to use (default: claude-opus-4-5-20251101)
 *   --limit <n>        Only evaluate first n cases
 *   --case <id>        Evaluate a single case by ID
 *   --skip-labeled     Skip cases where expected.action is null
 *   --output <file>    Output file (default: test-data/eval-results.md)
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireCredential } from '../src/keychain.js';
import { LinearClient } from '../src/linear.js';
import { triageBug, type TriageDecision, type PromptVersion, getDefaultPromptVersion } from '../src/triage.js';
import { defaultConfig, type Config } from '../src/config.js';

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

interface EvalResult {
  id: string;
  expected: TestCase['expected'];
  actual: TriageDecision;
  actionMatch: boolean | null; // null if expected is null
  teamMatch: boolean | null;
  notes: string;
}

function parseArgs(): {
  model: string;
  limit: number | null;
  caseId: string | null;
  skipUnlabeled: boolean;
  output: string;
  promptVersion: PromptVersion;
} {
  const args = process.argv.slice(2);
  let model = 'claude-opus-4-5-20251101';
  let limit: number | null = null;
  let caseId: string | null = null;
  let skipUnlabeled = false;
  let output = 'test-data/eval-results.md';
  let promptVersion: PromptVersion = getDefaultPromptVersion();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--case' && args[i + 1]) {
      caseId = args[++i];
    } else if (args[i] === '--skip-unlabeled') {
      skipUnlabeled = true;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === '--prompt-version' && args[i + 1]) {
      const v = args[++i];
      if (v === 'v1' || v === 'v2') {
        promptVersion = v;
      } else {
        console.warn(`Unknown prompt version: ${v}, using default`);
      }
    }
  }

  return { model, limit, caseId, skipUnlabeled, output, promptVersion };
}

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log('Bug Triage Evaluator');
  console.log('====================');
  console.log(`Model: ${opts.model}`);
  console.log(`Prompt version: ${opts.promptVersion}`);

  // Load test cases
  const casesPath = join(__dirname, '..', 'test-data', 'test-cases.json');
  if (!existsSync(casesPath)) {
    console.error('test-cases.json not found. Run generate-test-cases.ts first.');
    process.exit(1);
  }

  const testFile: TestCasesFile = JSON.parse(readFileSync(casesPath, 'utf8'));
  let cases = testFile.cases;

  // Filter cases
  if (opts.caseId) {
    cases = cases.filter((c) => c.id === opts.caseId);
    if (cases.length === 0) {
      console.error(`Case not found: ${opts.caseId}`);
      process.exit(1);
    }
  }
  if (opts.skipUnlabeled) {
    cases = cases.filter((c) => c.expected.action !== null);
  }
  if (opts.limit) {
    cases = cases.slice(0, opts.limit);
  }

  console.log(`Evaluating ${cases.length} test cases...\n`);

  // Initialize clients
  const anthropic = new Anthropic({ apiKey: requireCredential('ANTHROPIC_API_KEY') });
  const linear = new LinearClient(requireCredential('LINEAR_API_KEY'));

  const config: Config = {
    ...defaultConfig,
    claudeModel: opts.model,
    dryRun: true,
    verbose: false,
  };

  const results: EvalResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    console.log(`[${i + 1}/${cases.length}] ${testCase.id}`);
    console.log(`  Message: ${testCase.message.substring(0, 60)}...`);

    try {
      // Get Linear results (real search or mocked)
      let existingIssues = testCase.mockLinearResults ?? [];
      if (existingIssues.length === 0 && !testCase.mockLinearResults) {
        // Do real Linear search
        const keywords = testCase.message
          .replace(/<@[A-Z0-9]+>/g, '')
          .replace(/<https?:\/\/[^|>]+(?:\|[^>]+)?>/g, '')
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .slice(0, 5)
          .join(' ');
        if (keywords) {
          existingIssues = await linear.searchIssues(keywords, 5);
        }
      }

      // Run triage
      const decision = await triageBug(
        anthropic,
        {
          message: testCase.message,
          reporter: testCase.reporter,
          existingIssues,
        },
        config,
        { promptVersion: opts.promptVersion }
      );

      // Compare results
      const actionMatch =
        testCase.expected.action === null ? null : decision.action === testCase.expected.action;

      const teamMatch =
        testCase.expected.team === null || testCase.expected.action !== 'new_bug'
          ? null
          : decision.newTicket?.team === testCase.expected.team;

      results.push({
        id: testCase.id,
        expected: testCase.expected,
        actual: decision,
        actionMatch,
        teamMatch,
        notes: testCase.expected.notes ?? '',
      });

      const matchIcon = actionMatch === null ? '?' : actionMatch ? '✓' : '✗';
      console.log(`  Result: ${decision.action} (${decision.confidence}) ${matchIcon}`);
      console.log(`  Explanation: ${decision.explanation.substring(0, 80)}...`);
    } catch (err) {
      console.error(`  Error: ${err}`);
      results.push({
        id: testCase.id,
        expected: testCase.expected,
        actual: {
          action: 'needs_info',
          explanation: `Error: ${err}`,
          confidence: 'low',
        },
        actionMatch: false,
        teamMatch: null,
        notes: `Error: ${err}`,
      });
    }

    console.log('');
  }

  // Generate report
  const report = generateReport(results, opts.model, opts.promptVersion);
  const outputPath = join(__dirname, '..', opts.output);
  writeFileSync(outputPath, report);
  console.log(`\nReport written to ${opts.output}`);

  // Print summary
  const labeled = results.filter((r) => r.actionMatch !== null);
  const correct = labeled.filter((r) => r.actionMatch === true);
  console.log(`\nSummary: ${correct.length}/${labeled.length} correct (${labeled.length > 0 ? Math.round((correct.length / labeled.length) * 100) : 0}%)`);
}

function generateReport(results: EvalResult[], model: string, promptVersion: PromptVersion): string {
  const now = new Date().toISOString();
  const labeled = results.filter((r) => r.actionMatch !== null);
  const correct = labeled.filter((r) => r.actionMatch === true);
  const accuracy = labeled.length > 0 ? Math.round((correct.length / labeled.length) * 100) : 0;

  let report = `# Evaluation Results

**Generated:** ${now}
**Model:** ${model}
**Prompt Version:** ${promptVersion}
**Cases:** ${results.length} total, ${labeled.length} labeled
**Accuracy:** ${correct.length}/${labeled.length} (${accuracy}%)

## Results

| Case ID | Expected | Got | Action | Team | Notes |
|---------|----------|-----|--------|------|-------|
`;

  for (const r of results) {
    const actionIcon = r.actionMatch === null ? '⚪' : r.actionMatch ? '✅' : '❌';
    const teamIcon =
      r.teamMatch === null ? '' : r.teamMatch ? '✅' : '❌';
    const expected = r.expected.action ?? 'unlabeled';
    const got = r.actual.action;
    const expectedTeam = r.expected.team ?? '';
    const gotTeam = r.actual.newTicket?.team ?? '';
    const teamStr = expectedTeam || gotTeam ? `${expectedTeam}→${gotTeam} ${teamIcon}` : '';

    report += `| ${r.id} | ${expected} | ${got} | ${actionIcon} | ${teamStr} | ${r.notes} |\n`;
  }

  // Add failure analysis section
  const failures = results.filter((r) => r.actionMatch === false);
  if (failures.length > 0) {
    report += `\n## Failures (${failures.length})\n\n`;
    for (const f of failures) {
      report += `### ${f.id}\n\n`;
      report += `**Expected:** ${f.expected.action}`;
      if (f.expected.team) report += ` (${f.expected.team})`;
      report += '\n\n';
      report += `**Got:** ${f.actual.action}`;
      if (f.actual.newTicket?.team) report += ` (${f.actual.newTicket.team})`;
      report += '\n\n';
      report += `**Explanation:** ${f.actual.explanation}\n\n`;
      if (f.actual.ticketLink) {
        report += `**Linked:** ${f.actual.ticketLink}\n\n`;
      }
      report += '---\n\n';
    }
  }

  return report;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
