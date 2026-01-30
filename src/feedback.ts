/**
 * Feedback loop for capturing and analyzing corrections to bot decisions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TriageDecision } from './triage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Correction {
  messageTs: string;
  messageText: string;
  botDecision: TriageDecision;
  humanCorrection: {
    action: string;
    team?: string;
    reason: string;
  };
  timestamp: string;
  reporter?: string;
}

export interface CorrectionLog {
  corrections: Correction[];
  lastUpdated: string;
}

export interface TriageLog {
  messageTs: string;
  messageText: string;
  decision: TriageDecision;
  timestamp: string;
  reporter: string;
  wasCorrect: boolean | null; // null until human feedback
}

export interface TriageHistory {
  logs: TriageLog[];
  lastUpdated: string;
}

/**
 * Feedback manager for capturing and analyzing corrections.
 */
export class FeedbackManager {
  private correctionsPath: string;
  private historyPath: string;
  private corrections: CorrectionLog;
  private history: TriageHistory;

  constructor(dataDir?: string) {
    const dir = dataDir ?? join(__dirname, '..', 'data');

    // Ensure data directory exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.correctionsPath = join(dir, 'corrections.json');
    this.historyPath = join(dir, 'triage-history.json');
    this.corrections = this.loadCorrections();
    this.history = this.loadHistory();
  }

  private loadCorrections(): CorrectionLog {
    try {
      if (existsSync(this.correctionsPath)) {
        return JSON.parse(readFileSync(this.correctionsPath, 'utf8'));
      }
    } catch {
      // Ignore errors
    }
    return {
      corrections: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  private loadHistory(): TriageHistory {
    try {
      if (existsSync(this.historyPath)) {
        return JSON.parse(readFileSync(this.historyPath, 'utf8'));
      }
    } catch {
      // Ignore errors
    }
    return {
      logs: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  private saveCorrections(): void {
    this.corrections.lastUpdated = new Date().toISOString();
    writeFileSync(this.correctionsPath, JSON.stringify(this.corrections, null, 2));
  }

  private saveHistory(): void {
    this.history.lastUpdated = new Date().toISOString();
    writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2));
  }

  /**
   * Log a triage decision for later feedback.
   */
  logDecision(
    messageTs: string,
    messageText: string,
    decision: TriageDecision,
    reporter: string
  ): void {
    const log: TriageLog = {
      messageTs,
      messageText,
      decision,
      timestamp: new Date().toISOString(),
      reporter,
      wasCorrect: null,
    };

    this.history.logs.push(log);

    // Keep only last 1000 logs
    if (this.history.logs.length > 1000) {
      this.history.logs = this.history.logs.slice(-1000);
    }

    this.saveHistory();
  }

  /**
   * Record a correction to a bot decision.
   */
  logCorrection(correction: Omit<Correction, 'timestamp'>): void {
    const fullCorrection: Correction = {
      ...correction,
      timestamp: new Date().toISOString(),
    };

    this.corrections.corrections.push(fullCorrection);
    this.saveCorrections();

    // Also mark the original log as incorrect
    const log = this.history.logs.find(l => l.messageTs === correction.messageTs);
    if (log) {
      log.wasCorrect = false;
      this.saveHistory();
    }
  }

  /**
   * Mark a decision as correct (positive feedback).
   */
  markCorrect(messageTs: string): void {
    const log = this.history.logs.find(l => l.messageTs === messageTs);
    if (log) {
      log.wasCorrect = true;
      this.saveHistory();
    }
  }

  /**
   * Get all corrections since a given date.
   */
  getCorrections(since?: string): Correction[] {
    if (!since) {
      return this.corrections.corrections;
    }

    const sinceDate = new Date(since);
    return this.corrections.corrections.filter(
      c => new Date(c.timestamp) >= sinceDate
    );
  }

  /**
   * Get corrections grouped by pattern.
   */
  getPatternAnalysis(): Map<string, Correction[]> {
    const patterns = new Map<string, Correction[]>();

    for (const correction of this.corrections.corrections) {
      const key = `${correction.botDecision.action}→${correction.humanCorrection.action}`;
      const existing = patterns.get(key) ?? [];
      existing.push(correction);
      patterns.set(key, existing);
    }

    return patterns;
  }

  /**
   * Get decision accuracy statistics.
   */
  getAccuracyStats(): {
    total: number;
    correct: number;
    incorrect: number;
    pending: number;
    accuracy: number;
  } {
    const total = this.history.logs.length;
    const correct = this.history.logs.filter(l => l.wasCorrect === true).length;
    const incorrect = this.history.logs.filter(l => l.wasCorrect === false).length;
    const pending = this.history.logs.filter(l => l.wasCorrect === null).length;
    const accuracy = correct + incorrect > 0
      ? correct / (correct + incorrect)
      : 0;

    return { total, correct, incorrect, pending, accuracy };
  }

  /**
   * Get decision history for a specific message.
   */
  getDecisionHistory(messageTs: string): TriageLog | null {
    return this.history.logs.find(l => l.messageTs === messageTs) ?? null;
  }

  /**
   * Get all logs.
   */
  getAllLogs(): TriageLog[] {
    return this.history.logs;
  }
}

/**
 * Analyze feedback patterns and generate a report.
 */
export function analyzePatterns(corrections: Correction[]): string {
  if (corrections.length === 0) {
    return 'No corrections to analyze.';
  }

  // Group by error type
  const errorTypes = new Map<string, number>();
  const teamErrors = new Map<string, number>();
  const reasons = new Map<string, string[]>();

  for (const c of corrections) {
    // Track action confusion
    const actionKey = `${c.botDecision.action}→${c.humanCorrection.action}`;
    errorTypes.set(actionKey, (errorTypes.get(actionKey) ?? 0) + 1);

    // Track team routing errors
    if (c.botDecision.newTicket?.team && c.humanCorrection.team) {
      const teamKey = `${c.botDecision.newTicket.team}→${c.humanCorrection.team}`;
      teamErrors.set(teamKey, (teamErrors.get(teamKey) ?? 0) + 1);
    }

    // Collect reasons
    const reasonList = reasons.get(actionKey) ?? [];
    if (c.humanCorrection.reason) {
      reasonList.push(c.humanCorrection.reason);
    }
    reasons.set(actionKey, reasonList);
  }

  // Build report
  let report = `# Feedback Analysis Report

**Period:** ${corrections[corrections.length - 1]?.timestamp ?? 'N/A'} to ${corrections[0]?.timestamp ?? 'N/A'}
**Total corrections:** ${corrections.length}

## Action Confusion Matrix

| Error Type | Count | % of Errors |
|------------|-------|-------------|
`;

  const sortedErrors = [...errorTypes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedErrors) {
    const pct = ((count / corrections.length) * 100).toFixed(1);
    report += `| ${type} | ${count} | ${pct}% |\n`;
  }

  if (teamErrors.size > 0) {
    report += `\n## Team Routing Errors\n\n| Routing Error | Count |\n|---------------|-------|\n`;
    const sortedTeam = [...teamErrors.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sortedTeam) {
      report += `| ${type} | ${count} |\n`;
    }
  }

  report += `\n## Common Reasons by Error Type\n\n`;
  for (const [type, reasonList] of reasons) {
    if (reasonList.length === 0) continue;
    report += `### ${type}\n\n`;
    const unique = [...new Set(reasonList)];
    for (const reason of unique.slice(0, 5)) {
      report += `- ${reason}\n`;
    }
    report += '\n';
  }

  // Recommendations
  report += `## Recommendations\n\n`;

  const topError = sortedErrors[0];
  if (topError) {
    const [errorType] = topError;
    if (errorType.includes('defer→new_bug')) {
      report += `- **Too cautious:** Bot is deferring when it should create tickets. Add more NEW_BUG signals to the prompt.\n`;
    } else if (errorType.includes('new_bug→defer')) {
      report += `- **Too aggressive:** Bot is creating tickets when it should defer. Add more DEFER signals to the prompt.\n`;
    }
  }

  return report;
}
