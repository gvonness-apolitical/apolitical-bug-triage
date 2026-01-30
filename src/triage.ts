/**
 * Bug triage logic using Claude.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.js';
import type { LinearIssue } from './linear.js';
import type { ReporterProfile } from './slack.js';

export interface TriageDecision {
  action: 'existing_ticket' | 'new_bug' | 'not_a_bug' | 'needs_info' | 'defer';
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  ticketLink?: string;
  newTicket?: {
    team: 'platform' | 'enterprise' | 'ai' | 'data';
    title: string;
    description: string;
    priority: 'urgent' | 'high' | 'medium' | 'low';
  };
}

export interface TriageContext {
  message: string;
  reporter: string;
  permalink?: string;
  existingIssues: LinearIssue[];
  reporterProfile?: ReporterProfile;
}

export interface TriageOptions {
  promptVersion?: PromptVersion;
}

export type PromptVersion = 'v1' | 'v2';

/**
 * Result of detecting context references in a message.
 */
export interface ContextReferenceResult {
  hasContextReference: boolean;
  patterns: string[];
}

/**
 * Detect references to previous context in a message.
 * These indicate the message may be referencing a previous issue
 * and should likely be deferred or marked as existing_ticket.
 */
export function detectContextReferences(message: string): ContextReferenceResult {
  const patterns: Array<{ regex: RegExp; name: string }> = [
    { regex: /same (?:issue|problem|bug|thing)/i, name: 'same issue reference' },
    { regex: /repeat of/i, name: 'repeat reference' },
    { regex: /happening again/i, name: 'recurrence' },
    { regex: /still (?:happening|broken|not working|an issue)/i, name: 'ongoing issue' },
    { regex: /as (?:mentioned|reported|discussed|noted)(?: above| earlier| before)?/i, name: 'prior mention' },
    { regex: /(?:above|earlier|before|previous) (?:issue|bug|problem|report)/i, name: 'prior issue reference' },
    { regex: /(?:following up|follow-up|followup) on/i, name: 'follow-up' },
    { regex: /related to (?:the|that|this|my) (?:earlier|previous|other)/i, name: 'related reference' },
    { regex: /see (?:above|thread|conversation)/i, name: 'thread reference' },
  ];

  const matchedPatterns: string[] = [];

  for (const { regex, name } of patterns) {
    if (regex.test(message)) {
      matchedPatterns.push(name);
    }
  }

  return {
    hasContextReference: matchedPatterns.length > 0,
    patterns: matchedPatterns,
  };
}

/**
 * Build the V1 prompt (original, for baseline comparison).
 */
function buildPromptV1(context: TriageContext): string {
  const existingIssuesText =
    context.existingIssues.length > 0
      ? context.existingIssues
          .map(
            (issue) =>
              `- [${issue.identifier}] ${issue.title} (${issue.state}, ${issue.team})\n  URL: ${issue.url}`
          )
          .join('\n')
      : 'No similar issues found.';

  return `You are a bug triage assistant for Apolitical's engineering team.

## Bug Report from Slack

**Reporter:** ${context.reporter}
**Message:**
${context.message}

${context.permalink ? `**Slack Link:** ${context.permalink}` : ''}

## Existing Linear Tickets (potential duplicates)

${existingIssuesText}

## Team Routing Guide

Route bugs to the appropriate team based on the affected area:

- **Platform**: Infrastructure, authentication (Auth0, login, password reset), performance, search, notifications, emails, content publishing, caching, core UI/UX issues
- **Enterprise**: Academies, cohorts, admin UI/API, B2B features, communities, courses (enrollment, progress, completion), partner/client-specific issues
- **AI**: AI features, LLMs, Futura, learning tracks, AI feedback, moderation, chatbots
- **Data**: dbt, BigQuery, ThoughtSpot, analytics, reporting, dashboards, data pipelines

**Default to Platform** if the area is unclear. Enterprise is for academy/cohort/community-specific features.

## Your Task

Analyze this bug report and decide the appropriate action. BE VERY CONSERVATIVE.

### Actions

**defer** (DEFAULT) - Use this when ANY of these apply:
- You're not 100% certain what the right action is
- Could be a bug OR a support/config issue
- Could be user error OR a real problem
- The reporter is uncertain ("not sure if this is a bug", "is this expected?")
- It's about a specific user's issue (could be account-specific)
- Framed as a question ("Have we changed...?", "Is this a bug?")
- References previous context you don't have ("same issue as above")

This is the SAFE default. A human will review and decide.

**new_bug** - ONLY when ALL of these are true:
- Clearly describes broken functionality (not "might be broken")
- Affects the product broadly (not one user's account)
- Has enough detail: what's broken, where, what happens
- You have HIGH confidence this is a product bug

**existing_ticket** - ONLY if a Linear ticket above is clearly the SAME issue (not just related topic)

**not_a_bug** - ONLY when CLEARLY one of:
- Explicit feature request ("it would be nice if...")
- How-to question ("how do I...")
- Content/copy error (typo, wrong text - not a technical bug)

**needs_info** - RARELY USE THIS. Only when the message is SO vague you cannot even defer meaningfully:
- Just a link with no description
- "There's an issue" with zero context
- Screenshot reference with no explanation

DO NOT use needs_info just because you want more detail. If you understand the general problem but are unsure how to act, use **defer** instead.

## Examples

**defer**: "Users can't enroll in the course" - Could be a bug OR permissions/config issue
**defer**: "Getting errors when posting" - Need to investigate if it's a bug or user-specific
**defer**: "Have we changed something on the homepage?" - Reporter is uncertain
**defer**: "Same login issue as before" - References context we don't have

**new_bug**: "403 error on /events page for logged-out users, reproducible" - Clear, specific, actionable
**new_bug**: "Search returns no results for 'leadership' - returns empty on Firefox and Chrome" - Clear broken functionality

**not_a_bug**: "Can you help reset Sarah's password?" - Support request
**not_a_bug**: "It would be great if we could filter by date" - Feature request

**needs_info**: "I'm getting this" (with no other context) - Genuinely cannot understand the issue
**needs_info**: "Check this thread: [link]" - No description at all

## Response Format

Respond with ONLY a JSON object (no markdown code blocks):

{
  "action": "existing_ticket" | "new_bug" | "not_a_bug" | "needs_info" | "defer",
  "explanation": "Brief explanation for the Slack reply (1-2 sentences, friendly tone)",
  "confidence": "high" | "medium" | "low",
  "ticketLink": "https://linear.app/... (only if action is existing_ticket)",
  "newTicket": {
    "team": "platform" | "enterprise" | "ai" | "data",
    "title": "Clear, descriptive bug title",
    "description": "## Reporter\\n${context.reporter}\\n\\n## Where?\\n[affected area]\\n\\n## What?\\n[description of the bug]\\n\\n## Expected vs Actual\\n[what should happen vs what is happening]\\n\\n## Slack Thread\\n${context.permalink || 'N/A'}",
    "priority": "urgent" | "high" | "medium" | "low"
  }
}

## Decision Rules

- Only include "ticketLink" if action is "existing_ticket"
- Only include "newTicket" if action is "new_bug"
- For priority: "urgent" = production down/data loss, "high" = blocking users, "medium" = annoying but workaround exists, "low" = minor issue
- **If you're unsure, use "defer"** - this is the safe default
- **If confidence is not "high", do NOT use "new_bug"** - use "defer" instead
- **Do NOT ask for more info unless the message is completely incomprehensible**
- Most #bug-hunt messages are ambiguous - defer is usually correct`;
}

/**
 * Build the V2 prompt (improved with DEFER/NEW_BUG signals, edge cases, and decision heuristics).
 */
function buildPromptV2(context: TriageContext): string {
  const existingIssuesText =
    context.existingIssues.length > 0
      ? context.existingIssues
          .map(
            (issue) =>
              `- [${issue.identifier}] ${issue.title} (${issue.state}, ${issue.team})\n  URL: ${issue.url}`
          )
          .join('\n')
      : 'No similar issues found.';

  // Detect context references
  const contextRef = detectContextReferences(context.message);
  const contextNote = contextRef.hasContextReference
    ? `\n**Context Note:** This message appears to reference a previous issue (detected: ${contextRef.patterns.join(', ')}). Consider defer or existing_ticket if the reference isn't clear.\n`
    : '';

  // Build reporter context if available
  let reporterContextSection = '';
  if (context.reporterProfile) {
    const profile = context.reporterProfile;
    const accuracy = profile.reportCount > 0
      ? Math.round((profile.confirmedBugs / profile.reportCount) * 100)
      : 0;
    const role = profile.isEngineer ? 'Engineer' : 'Non-engineer';

    reporterContextSection = `
## Reporter Context
- **Name:** ${profile.name}
- **Previous reports:** ${profile.reportCount} (${accuracy}% were confirmed bugs)
- **Role:** ${role}

${profile.reportCount >= 10 && accuracy >= 70
  ? '**Note:** Experienced reporter with high accuracy - lean toward new_bug if report has technical details.'
  : profile.reportCount === 0
    ? '**Note:** First-time reporter - verify details carefully before creating ticket.'
    : ''}
`;
  }

  return `You are a bug triage assistant for Apolitical's engineering team.

## Bug Report from Slack

**Reporter:** ${context.reporter}
**Message:**
${context.message}
${contextNote}
${context.permalink ? `**Slack Link:** ${context.permalink}` : ''}
${reporterContextSection}

## Existing Linear Tickets (potential duplicates)

${existingIssuesText}

## Team Routing Guide

Route bugs to the appropriate team based on the affected area:

- **Platform**: Infrastructure, authentication (Auth0, login, password reset), performance, search, notifications, email templates, content publishing, caching, core UI/UX issues, homepage, feed, carousel
- **Enterprise**: Academies, cohorts, admin UI/API, B2B features, academy-specific communities, courses (enrollment, progress, completion), polls, quizzes, partner/client-specific issues
- **AI**: AI features, LLMs, Futura, learning tracks, AI feedback, moderation, chatbots
- **Data**: dbt, BigQuery, ThoughtSpot, analytics, reporting, dashboards, data pipelines, email sending/tracking, HubSpot sync, course reminders

**Default to Platform** if the area is unclear. Enterprise is for academy/cohort/community-specific features.

## Team Routing Disambiguation
- **Communities**: Platform = main site communities. Enterprise = academy-specific or cohort communities.
- **Email**: Data = sending/tracking/automation. Platform = templates/content display.
- **Polls/Quizzes**: Always Enterprise (these are academy features).
- **Courses**: Platform = main site course pages. Enterprise = academy/cohort enrollment management.
- **Forums**: Platform = general site forums. Enterprise = academy-specific forums (GAIC, etc.).

## Your Task

Analyze this bug report and decide the appropriate action. BE VERY CONSERVATIVE.

### Actions

**defer** (DEFAULT) - Use this when ANY of these apply:
- You're not 100% certain what the right action is
- Could be a bug OR a support/config issue
- Could be user error OR a real problem
- The reporter is uncertain ("not sure if this is a bug", "is this expected?")
- It's about a specific user's issue (could be account-specific)
- Framed as a question ("Have we changed...?", "Is this a bug?")
- References previous context you don't have ("same issue as above")

This is the SAFE default. A human will review and decide.

**STRONG DEFER signals** - If ANY appear, default to defer:
- Question framing: "Have we changed...?", "Is this expected?", "Did something break?"
- Caching/publishing: "not updating", "changes not appearing", "published but not showing"
- Single user: "a learner is experiencing", "one user can't..."
- External services: Contentful, HubSpot, third-party tools
- Configuration: "settings", "permissions", "whitelist", "access"
- Uncertainty language: "seems like", "might be", "not sure if"

**new_bug** - ONLY when ALL of these are true:
- Clearly describes broken functionality (not "might be broken")
- Affects the product broadly (not one user's account)
- Has enough detail: what's broken, where, what happens
- You have HIGH confidence this is a product bug

**STRONG NEW_BUG signals** - These override uncertainty:
- Time-bounded outage: "for X hours", "since yesterday", "stopped working today"
- Error codes: 403, 404, 500 (reproducible, not user-specific)
- Behavioral violation: "receiving X despite unsubscribing", "button does nothing"
- Performance regression: "slow", "timing out" (with specifics)
- Multiple users: "users are seeing", "production-wide"
- Clear broken state: "crash", "blank screen", "infinite loop"

**existing_ticket** - ONLY if a Linear ticket above is clearly the SAME issue (not just related topic)

**not_a_bug** - ONLY when CLEARLY one of:
- Explicit feature request ("it would be nice if...")
- How-to question ("how do I...")
- Content/copy error (typo, wrong text - not a technical bug)

**needs_info** - RARELY USE THIS. Only when the message is SO vague you cannot even defer meaningfully:
- Just a link with no description
- "There's an issue" with zero context
- Screenshot reference with no explanation

DO NOT use needs_info just because you want more detail. If you understand the general problem but are unsure how to act, use **defer** instead.

## Examples

**defer**: "Users can't enroll in the course" - Could be a bug OR permissions/config issue
**defer**: "Getting errors when posting" - Need to investigate if it's a bug or user-specific
**defer**: "Have we changed something on the homepage?" - Reporter is uncertain
**defer**: "Same login issue as before" - References context we don't have

**new_bug**: "403 error on /events page for logged-out users, reproducible" - Clear, specific, actionable
**new_bug**: "Search returns no results for 'leadership' - returns empty on Firefox and Chrome" - Clear broken functionality

**not_a_bug**: "Can you help reset Sarah's password?" - Support request
**not_a_bug**: "It would be great if we could filter by date" - Feature request

**needs_info**: "I'm getting this" (with no other context) - Genuinely cannot understand the issue
**needs_info**: "Check this thread: [link]" - No description at all

## Edge Case Examples

**defer** (looks like bug but needs investigation):
- "Content not updating after publish" - Could be caching, permissions, or CMS
- "Course not appearing in search" - Could be indexing or configuration
- "User can't access X" - Could be account-specific
- "Notifications not working for [user]" - Single user issue
- "Is this a bug or expected behavior?" - Explicit uncertainty

**new_bug** (seems vague but actionable):
- "Platform slow since this morning" - Performance regression, time-bounded
- "Notifications haven't worked for 6 hours" - Clear outage with timeline
- "Getting emails despite unsubscribing" - Clear behavioral violation
- "403 errors affecting all users" - Error code + broad impact
- "Button does nothing when clicked" - Clear broken functionality

## Response Format

Respond with ONLY a JSON object (no markdown code blocks):

{
  "action": "existing_ticket" | "new_bug" | "not_a_bug" | "needs_info" | "defer",
  "explanation": "Brief explanation for the Slack reply (1-2 sentences, friendly tone)",
  "confidence": "high" | "medium" | "low",
  "ticketLink": "https://linear.app/... (only if action is existing_ticket)",
  "newTicket": {
    "team": "platform" | "enterprise" | "ai" | "data",
    "title": "Clear, descriptive bug title",
    "description": "## Reporter\\n${context.reporter}\\n\\n## Where?\\n[affected area]\\n\\n## What?\\n[description of the bug]\\n\\n## Expected vs Actual\\n[what should happen vs what is happening]\\n\\n## Slack Thread\\n${context.permalink || 'N/A'}",
    "priority": "urgent" | "high" | "medium" | "low"
  }
}

## Decision Rules

- Only include "ticketLink" if action is "existing_ticket"
- Only include "newTicket" if action is "new_bug"
- For priority: "urgent" = production down/data loss, "high" = blocking users, "medium" = annoying but workaround exists, "low" = minor issue
- **If you're unsure, use "defer"** - this is the safe default
- **If confidence is not "high", do NOT use "new_bug"** - use "defer" instead
- **Do NOT ask for more info unless the message is completely incomprehensible**
- Most #bug-hunt messages are ambiguous - defer is usually correct

## Decision Heuristics (apply in order)
1. Phrased as question? → defer (unless clearly rhetorical)
2. Mentions single specific user? → defer (account-specific)
3. References caching/publishing? → defer (support issue likely)
4. Time-bounded outage + multiple users? → new_bug
5. Clear behavioral violation (X should happen, Y happens)? → new_bug
6. Error code + reproducible? → new_bug
7. When in doubt → defer`;
}

/**
 * Available prompt versions for A/B testing.
 */
const PROMPT_BUILDERS: Record<PromptVersion, (context: TriageContext) => string> = {
  v1: buildPromptV1,
  v2: buildPromptV2,
};

/**
 * Get the current default prompt version.
 */
export function getDefaultPromptVersion(): PromptVersion {
  return 'v2';
}

/**
 * Build a prompt using the specified version.
 */
function buildPrompt(context: TriageContext, version: PromptVersion = 'v2'): string {
  const builder = PROMPT_BUILDERS[version];
  if (!builder) {
    throw new Error(`Unknown prompt version: ${version}`);
  }
  return builder(context);
}

/**
 * Parse Claude's response into a TriageDecision.
 */
export function parseResponse(responseText: string): TriageDecision {
  // Try to extract JSON from the response
  let jsonStr = responseText.trim();

  // Remove markdown code blocks if present
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(jsonStr);

    // Validate required fields
    if (!parsed.action || !parsed.explanation || !parsed.confidence) {
      throw new Error('Missing required fields in response');
    }

    // Validate action
    const validActions = ['existing_ticket', 'new_bug', 'not_a_bug', 'needs_info', 'defer'];
    if (!validActions.includes(parsed.action)) {
      throw new Error(`Invalid action: ${parsed.action}`);
    }

    return parsed as TriageDecision;
  } catch (err) {
    console.error('Failed to parse Claude response:', responseText);
    throw new Error(`Failed to parse triage response: ${err}`);
  }
}

/**
 * Extract keywords from a message for Linear search.
 */
export function extractKeywords(message: string): string {
  // Remove mentions, URLs, and common words
  const cleaned = message
    .replace(/<@[A-Z0-9]+>/g, '') // Remove Slack mentions
    .replace(/<https?:\/\/[^|>]+(?:\|[^>]+)?>/g, '') // Remove Slack-formatted URLs
    .replace(/https?:\/\/\S+/g, '') // Remove plain URLs
    .replace(/[^\w\s-]/g, ' ') // Remove special characters
    .toLowerCase();

  // Split into words and filter
  const words = cleaned.split(/\s+/).filter((word) => {
    // Filter out common words and very short words
    const stopWords = [
      'the',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'shall',
      'can',
      'need',
      'dare',
      'ought',
      'used',
      'a',
      'an',
      'and',
      'but',
      'or',
      'for',
      'nor',
      'on',
      'at',
      'to',
      'from',
      'by',
      'with',
      'in',
      'of',
      'it',
      'its',
      'this',
      'that',
      'these',
      'those',
      'i',
      'you',
      'he',
      'she',
      'we',
      'they',
      'me',
      'him',
      'her',
      'us',
      'them',
      'my',
      'your',
      'his',
      'our',
      'their',
      'not',
      'no',
      'yes',
      'just',
      'only',
      'also',
      'very',
      'too',
      'so',
      'as',
      'if',
      'when',
      'where',
      'why',
      'how',
      'what',
      'which',
      'who',
      'whom',
      'whose',
    ];
    return word.length > 2 && !stopWords.includes(word);
  });

  // Return top keywords (limit to avoid overly broad search)
  return words.slice(0, 8).join(' ');
}

/**
 * Triage a bug report using Claude.
 */
export async function triageBug(
  anthropic: Anthropic,
  context: TriageContext,
  config: Config,
  options: TriageOptions = {}
): Promise<TriageDecision> {
  const version = options.promptVersion ?? getDefaultPromptVersion();
  const prompt = buildPrompt(context, version);

  console.log('\n--- Sending to Claude ---');
  console.log(`Prompt version: ${version}`);
  if (config.verbose) {
    console.log(prompt);
  }

  const response = await anthropic.messages.create({
    model: config.claudeModel,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText =
    response.content[0].type === 'text' ? response.content[0].text : '';

  console.log('\n--- Claude Response ---');
  console.log(responseText);

  return parseResponse(responseText);
}
