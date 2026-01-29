# Apolitical Bug Triage

Automated bug triage for the #bug-hunt Slack channel using Claude.

## What it does

1. Fetches new messages from #bug-hunt since last run
2. For each message:
   - Searches Linear for potentially related tickets
   - Asks Claude to analyze and decide: existing ticket, new bug, not a bug, or needs info
   - If new bug: creates a Linear ticket with proper formatting
   - Posts a threaded reply to Slack with the decision

## Setup

### Prerequisites

- Node.js 20+
- macOS (uses Keychain for credentials)
- API keys for: Anthropic, Slack, Linear

### Install

```bash
npm install
```

### Credentials

Store credentials in macOS Keychain (same as apolitical-assistant):

```bash
# Add credentials (account: "claude")
security add-generic-password -a "claude" -s "ANTHROPIC_API_KEY" -w "sk-ant-..."
security add-generic-password -a "claude" -s "SLACK_TOKEN" -w "xoxb-..."
security add-generic-password -a "claude" -s "LINEAR_API_KEY" -w "lin_api_..."
```

Or set as environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export SLACK_TOKEN="xoxb-..."
export LINEAR_API_KEY="lin_api_..."
```

## Usage

### Dry Run (recommended for testing)

Read messages and analyze, but don't post replies or create tickets:

```bash
npm run triage:dry
```

### Full Run

Process messages and take action:

```bash
npm run triage
```

### Options

```bash
npx tsx src/index.ts --help

Options:
  -d, --dry-run           Read-only mode
  -v, --verbose           Verbose output
  --since <timestamp>     Process messages since Unix timestamp
  --channel <id>          Override Slack channel ID
  --model <model>         Claude model (default: claude-sonnet-4-20250514)
  --limit <n>             Max messages to process (default: 10)
```

### Examples

```bash
# Dry run with verbose output
npm run triage:dry -- -v

# Process messages from the last 24 hours
npm run triage:dry -- --since $(date -v-1d +%s)

# Use Opus for production quality
npm run triage -- --model claude-opus-4-5-20251101

# Process only 3 messages
npm run triage:dry -- --limit 3
```

## How it works

### Triage Decision Flow

```
Message → Extract keywords → Search Linear → Claude Analysis → Decision
                                                                  ↓
                                              ┌───────────────────┴───────────────────┐
                                              │                                       │
                                    existing_ticket                              new_bug
                                              │                                       │
                                    Reply with link                        Create Linear ticket
                                                                           Reply with link
```

### Team Routing

Claude routes bugs to teams based on keywords:

- **Platform**: GKE, k8s, infrastructure, auth0, OpenFGA, performance
- **Enterprise**: academies, cohorts, admin, B2B, SSO
- **AI**: AI, LLM, Futura, learning tracks, moderation
- **Data**: dbt, BigQuery, ThoughtSpot, analytics

### State Management

The script saves its last run timestamp to `.last-run` to avoid reprocessing messages.

## Prompt Evaluation

The project includes an evaluation framework for testing and refining the triage prompt.

### Setup Test Cases

```bash
# 1. Export historical messages from #bug-hunt
npm run eval:export

# 2. Generate test case file with placeholders
npm run eval:generate

# 3. Merge synthetic edge cases
npm run eval:merge-synthetic
```

### Label Test Cases

Edit `test-data/test-cases.json` and fill in expected outcomes:

```json
{
  "expected": {
    "action": "new_bug",      // existing_ticket | new_bug | not_a_bug | needs_info
    "team": "platform",       // platform | enterprise | ai | data (if new_bug)
    "confidence": "high",     // optional
    "notes": "Clear bug with stack trace"
  }
}
```

### Run Evaluation

```bash
# Run with Opus (production model)
npm run eval:run:opus

# Run with specific options
npm run eval:run -- --model claude-sonnet-4-20250514 --limit 10

# Evaluate a single case
npm run eval:run -- --case synth-clear-bug-stacktrace

# Skip unlabeled cases
npm run eval:run -- --skip-unlabeled
```

### Review Results

Results are written to `test-data/eval-results.md` with:
- Summary accuracy metrics
- Per-case comparison table
- Detailed failure analysis

### Iteration Workflow

1. Run evaluation: `npm run eval:run:opus`
2. Review failures in `test-data/eval-results.md`
3. Identify patterns in misclassifications
4. Update prompt in `src/triage.ts`
5. Re-run evaluation
6. Repeat until satisfied

### Test Data Files

- `test-data/historical-messages.json` - Exported messages from #bug-hunt
- `test-data/synthetic-cases.json` - Hand-crafted edge cases
- `test-data/test-cases.json` - Combined test set with expected outcomes
- `test-data/eval-results.md` - Latest evaluation results

## Development

```bash
# Type check
npm run typecheck

# Lint
npm run lint

# Format
npm run format
```

## Future Improvements

- [ ] Add Notion roadmap search
- [ ] Support for multiple channels
- [ ] Scheduled execution (cron/Cloud Scheduler)
- [ ] Slack app with slash command trigger
- [ ] Metrics/logging for triage decisions
