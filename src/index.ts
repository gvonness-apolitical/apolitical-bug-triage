#!/usr/bin/env node
/**
 * Bug Triage CLI
 *
 * Monitors #bug-hunt channel and triages bug reports using Claude.
 */

import { program } from 'commander';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireCredential } from './keychain.js';
import { defaultConfig, type Config } from './config.js';
import { SlackClient, type SlackMessage } from './slack.js';
import { LinearClient, getPriorityNumber } from './linear.js';
import { triageBug, extractKeywords, type TriageDecision } from './triage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', '.last-run');

// CLI setup
program
  .name('bug-triage')
  .description('Automated bug triage for #bug-hunt channel')
  .option('-d, --dry-run', 'Read-only mode: fetch and analyze but do not post replies or create tickets')
  .option('-v, --verbose', 'Verbose output')
  .option('--since <timestamp>', 'Process messages since this Unix timestamp (overrides saved state)')
  .option('--channel <id>', 'Override Slack channel ID')
  .option('--model <model>', 'Claude model to use', defaultConfig.claudeModel)
  .option('--limit <n>', 'Maximum messages to process', '10')
  .parse();

const options = program.opts();

/**
 * Load the last run timestamp from state file.
 */
function loadLastRunTimestamp(): number {
  if (options.since) {
    return parseFloat(options.since);
  }

  try {
    if (existsSync(STATE_FILE)) {
      const content = readFileSync(STATE_FILE, 'utf8');
      return parseFloat(content.trim());
    }
  } catch {
    // Ignore errors
  }

  // Default to 1 hour ago
  return Date.now() / 1000 - 3600;
}

/**
 * Save the current timestamp to state file.
 */
function saveLastRunTimestamp(timestamp: number): void {
  if (options.dryRun) {
    console.log(`[DRY RUN] Would save timestamp: ${timestamp}`);
    return;
  }
  writeFileSync(STATE_FILE, timestamp.toString());
}

/**
 * Format a triage decision for Slack reply.
 */
function formatSlackReply(decision: TriageDecision, ticketUrl?: string): string {
  let reply = '';

  switch (decision.action) {
    case 'existing_ticket':
      reply = `🔍 ${decision.explanation}\n\n📋 Related ticket: ${decision.ticketLink}`;
      break;

    case 'new_bug':
      if (ticketUrl) {
        reply = `🐛 ${decision.explanation}\n\n📋 Created: ${ticketUrl}`;
      } else {
        reply = `🐛 ${decision.explanation}`;
      }
      break;

    case 'not_a_bug':
      reply = `ℹ️ ${decision.explanation}`;
      break;

    case 'needs_info':
      reply = `❓ ${decision.explanation}`;
      break;

    case 'defer':
      reply = `👀 ${decision.explanation}\n\n_A human will review this and follow up._`;
      break;
  }

  // Add confidence indicator for low confidence decisions (but not for defer, which is already uncertain)
  if (decision.confidence === 'low' && decision.action !== 'defer') {
    reply += '\n\n_(Low confidence - please verify this assessment)_';
  }

  return reply;
}

/**
 * Process a single bug report.
 */
async function processBugReport(
  message: SlackMessage,
  slack: SlackClient,
  linear: LinearClient,
  anthropic: Anthropic,
  config: Config
): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing message: ${message.ts}`);
  console.log(`Text: ${message.text.substring(0, 100)}${message.text.length > 100 ? '...' : ''}`);

  // Get reporter name
  const reporter = await slack.getUserName(message.user);
  console.log(`Reporter: ${reporter}`);

  // Check if already triaged
  const alreadyTriaged = await slack.hasTriageReply(
    config.slackChannelId,
    message.ts
  );
  if (alreadyTriaged) {
    console.log('Already triaged (has bot reply), skipping.');
    return;
  }

  // Search Linear for similar issues
  const keywords = extractKeywords(message.text);
  console.log(`Search keywords: ${keywords}`);

  const existingIssues = keywords
    ? await linear.searchIssues(keywords, 5)
    : [];
  console.log(`Found ${existingIssues.length} potentially related issues.`);

  // Ask Claude to triage
  const decision = await triageBug(
    anthropic,
    {
      message: message.text,
      reporter,
      permalink: message.permalink,
      existingIssues,
    },
    config
  );

  console.log(`\nDecision: ${decision.action} (${decision.confidence} confidence)`);
  console.log(`Explanation: ${decision.explanation}`);

  // Execute the decision
  let ticketUrl: string | undefined;

  if (decision.action === 'new_bug' && decision.newTicket) {
    const teamId = config.linearTeams[decision.newTicket.team];
    if (!teamId) {
      console.error(`Unknown team: ${decision.newTicket.team}`);
    } else if (config.dryRun) {
      console.log(`\n[DRY RUN] Would create Linear ticket:`);
      console.log(`  Team: ${decision.newTicket.team} (${teamId})`);
      console.log(`  Title: ${decision.newTicket.title}`);
      console.log(`  Priority: ${decision.newTicket.priority}`);
      console.log(`  Description:\n${decision.newTicket.description}`);
    } else {
      console.log(`\nCreating Linear ticket...`);
      const issue = await linear.createIssue({
        teamId,
        title: decision.newTicket.title,
        description: decision.newTicket.description,
        priority: getPriorityNumber(decision.newTicket.priority),
        labelIds: [config.linearBugLabelId],
      });
      ticketUrl = issue.url;
      console.log(`Created: ${issue.identifier} - ${issue.url}`);
    }
  }

  // Post reply to Slack
  const reply = formatSlackReply(decision, ticketUrl);
  if (config.dryRun) {
    console.log(`\n[DRY RUN] Would post Slack reply:`);
    console.log(reply);
  } else {
    console.log(`\nPosting Slack reply...`);
    await slack.postThreadReply(config.slackChannelId, message.ts, reply);
    console.log('Reply posted.');
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  console.log('Bug Triage CLI');
  console.log('==============');

  // Build config
  const config: Config = {
    ...defaultConfig,
    slackChannelId: options.channel ?? defaultConfig.slackChannelId,
    claudeModel: options.model,
    dryRun: options.dryRun ?? false,
    verbose: options.verbose ?? false,
  };

  if (config.dryRun) {
    console.log('\n⚠️  DRY RUN MODE - No writes will be made\n');
  }

  // Load credentials
  console.log('Loading credentials...');
  const slackToken = requireCredential('SLACK_TOKEN');
  const linearApiKey = requireCredential('LINEAR_API_KEY');
  const anthropicApiKey = requireCredential('ANTHROPIC_API_KEY');

  // Initialize clients
  const slack = new SlackClient(slackToken);
  const linear = new LinearClient(linearApiKey);
  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  // Load state
  const since = loadLastRunTimestamp();
  const sinceDate = new Date(since * 1000);
  console.log(`\nFetching messages since: ${sinceDate.toISOString()}`);
  console.log(`Channel: ${config.slackChannelId}`);

  // Fetch messages
  const messages = await slack.getMessagesSince(config.slackChannelId, since);
  console.log(`Found ${messages.length} messages.`);

  // Limit messages to process
  const limit = parseInt(options.limit, 10);
  const toProcess = messages.slice(0, limit);

  if (toProcess.length === 0) {
    console.log('\nNo new messages to process.');
  } else {
    console.log(`\nProcessing ${toProcess.length} message(s)...`);

    for (const message of toProcess) {
      try {
        await processBugReport(message, slack, linear, anthropic, config);
      } catch (err) {
        console.error(`\nError processing message ${message.ts}:`, err);
        // Continue with next message
      }
    }
  }

  // Save state (latest timestamp)
  const newTimestamp = Date.now() / 1000;
  saveLastRunTimestamp(newTimestamp);
  console.log(`\nDone. Processed up to: ${new Date(newTimestamp * 1000).toISOString()}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
