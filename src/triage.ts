/**
 * Bug triage logic using Claude.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.js';
import { teamKeywords } from './config.js';
import type { LinearIssue } from './linear.js';

export interface TriageDecision {
  action: 'existing_ticket' | 'new_bug' | 'not_a_bug' | 'needs_info';
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

- **Platform**: Infrastructure, GKE, Kubernetes, deployments, CI/CD, databases, performance, Auth0, authentication, OpenFGA, authorization, scaling
- **Enterprise**: Academies, cohorts, admin UI/API, B2B features, white-label, SSO, SAML
- **AI**: AI features, LLMs, Futura, learning tracks, AI feedback, moderation, chatbots
- **Data**: dbt, BigQuery, ThoughtSpot, analytics, reporting, dashboards, data pipelines

## Your Task

Analyze this bug report and decide the appropriate action:

1. **existing_ticket** - This appears to be a duplicate or closely related to an existing Linear ticket
2. **new_bug** - This is a genuine new bug that needs a ticket created
3. **not_a_bug** - This is a support question, feature request, user error, or not actually a bug
4. **needs_info** - Cannot determine without more information from the reporter

## Response Format

Respond with ONLY a JSON object (no markdown code blocks, no explanation outside the JSON):

{
  "action": "existing_ticket" | "new_bug" | "not_a_bug" | "needs_info",
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

Notes:
- Only include "ticketLink" if action is "existing_ticket"
- Only include "newTicket" if action is "new_bug"
- For priority: "urgent" = production down/data loss, "high" = blocking users, "medium" = annoying but workaround exists, "low" = minor issue
- Be concise in the explanation - it will be posted to Slack
- If confidence is "low", err on the side of "needs_info"`;
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
    const validActions = ['existing_ticket', 'new_bug', 'not_a_bug', 'needs_info'];
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
