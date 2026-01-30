# Session Handoff - Bug Triage Prompt Iteration

**Date:** 2026-01-29
**Status:** Evaluation baseline established at 70% accuracy

## Summary

Built an evaluation framework for the bug triage prompt and iterated to improve accuracy from 33% → 63% → 70%.

## What Was Done

### 1. Evaluation Framework Created
- `scripts/export-historical.ts` - Export messages from #bug-hunt Slack channel
- `scripts/enrich-with-threads.ts` - Fetch thread replies for context
- `scripts/claude-label.ts` - Use Claude to suggest labels based on thread context
- `scripts/evaluate.ts` - Run test cases through triage prompt, output markdown report
- `test-data/test-cases.json` - 100 test cases (88 historical + 12 synthetic)
- `test-data/eval-results.md` - Latest evaluation results

### 2. Key Insight: Label Framing Matters
Initial labels were based on "what actually happened after thread discussion" but the prompt only sees the initial message. This caused 33% accuracy.

**Solution:** Relabeled all cases asking "what should the bot do given ONLY the initial message?" This reframing + adding `defer` action improved accuracy to 63%.

### 3. Prompt Iteration (63% → 70%)
Key changes to `src/triage.ts` prompt:
- Made `defer` the explicit DEFAULT action
- Made `needs_info` very restrictive (only for truly incomprehensible messages)
- Added concrete examples for each action
- Strengthened guidance: "If confidence is not high, do NOT use new_bug"
- Clarified team routing (Platform vs Enterprise)

## Current State

### Accuracy: 70% (57/81 labeled cases)

### Failure Patterns (24 failures)
| Type | Count | Notes |
|------|-------|-------|
| defer → new_bug | 7 | Still creates tickets for ambiguous cases |
| new_bug → defer | 7 | Too cautious on some clear bugs |
| existing_ticket → defer | 2 | Can't see "same issue" thread context |
| not_a_bug → defer/needs_info | 3 | Over-cautious on support requests |
| needs_info ↔ defer | 3 | Boundary cases |
| new_bug → needs_info | 1 | Screenshot reference |

### Team Routing
9 cases have wrong team assignment (mostly platform ↔ enterprise confusion). This is a secondary concern.

## Files to Know

```
src/
  triage.ts          # Main triage logic + prompt (lines 33-121 are the prompt)
  index.ts           # CLI entry point

scripts/
  evaluate.ts        # Run evaluation
  claude-label.ts    # Label test cases using Claude
  enrich-with-threads.ts  # Fetch Slack thread replies
  export-historical.ts    # Export from Slack

test-data/
  test-cases.json    # Test cases (git-crypt encrypted)
  eval-results.md    # Latest results (git-crypt encrypted)
  synthetic-cases.json  # Hand-crafted edge cases
```

## Useful Commands

```bash
# Run evaluation with Opus
npm run eval:run:opus

# Relabel all historical cases with new prompt framing
npm run eval:claude-label -- --relabel --apply --limit 100

# Refresh historical messages from Slack
npm run eval:refresh

# Compare two eval results
npm run eval:diff -- test-data/eval-results.md test-data/eval-results-old.md
```

## Potential Next Steps

1. **Further prompt tuning** - Address remaining defer↔new_bug confusion
2. **Team routing improvement** - Better heuristics for platform vs enterprise
3. **Test in production** - Run with `--dry-run` on live #bug-hunt messages
4. **Add more synthetic cases** - Cover edge cases the prompt struggles with
5. **Consider multi-turn** - For `existing_ticket` detection (would need thread context)

## Git Status

All changes are committed. The test data files are encrypted with git-crypt (same key as apolitical-assistant repo).

## Notes

- The `defer` action is intentional - better to have humans review ambiguous cases than auto-create bad tickets
- 70% accuracy with conservative deferral is acceptable for a first-pass triage bot
- The prompt is in `src/triage.ts` starting at line 44 (the `buildPrompt` function)
