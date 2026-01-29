/**
 * Bug triage logic using Claude.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.js';
import { teamKeywords } from './config.js';
import type { LinearIssue } from './linear.js';

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
}

/**
 * Build the prompt for Claude.
 */
function buildPrompt(context: TriageContext): string {
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
 * Parse Claude's response into a TriageDecision.
 */
function parseResponse(responseText: string): TriageDecision {
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
 * Suggest a team based on message keywords.
 */
export function suggestTeam(
  message: string
): 'platform' | 'enterprise' | 'ai' | 'data' | null {
  const lowerMessage = message.toLowerCase();

  for (const [team, keywords] of Object.entries(teamKeywords)) {
    for (const keyword of keywords) {
      if (lowerMessage.includes(keyword)) {
        return team as 'platform' | 'enterprise' | 'ai' | 'data';
      }
    }
  }

  return null;
}

/**
 * Triage a bug report using Claude.
 */
export async function triageBug(
  anthropic: Anthropic,
  context: TriageContext,
  config: Config
): Promise<TriageDecision> {
  const prompt = buildPrompt(context);

  console.log('\n--- Sending to Claude ---');
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
