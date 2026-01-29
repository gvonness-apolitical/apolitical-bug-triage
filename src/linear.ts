/**
 * Linear API client for bug triage.
 */

import { LinearClient as LinearSDK } from '@linear/sdk';

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  state: string;
  team: string;
}

export interface CreateIssueParams {
  teamId: string;
  title: string;
  description: string;
  priority?: number;
  labelIds?: string[];
}

export class LinearClient {
  private client: LinearSDK;

  constructor(apiKey: string) {
    this.client = new LinearSDK({ apiKey });
  }

  /**
   * Search for issues matching keywords.
   */
  async searchIssues(query: string, limit: number = 10): Promise<LinearIssue[]> {
    const result = await this.client.searchIssues(query, { first: limit });

    const issues: LinearIssue[] = [];
    for (const node of result.nodes) {
      const state = await node.state;
      const team = await node.team;

      issues.push({
        id: node.id,
        identifier: node.identifier,
        title: node.title,
        description: node.description ?? undefined,
        url: node.url,
        state: state?.name ?? 'unknown',
        team: team?.name ?? 'unknown',
      });
    }

    return issues;
  }

  /**
   * Create a new issue.
   */
  async createIssue(params: CreateIssueParams): Promise<LinearIssue> {
    const result = await this.client.createIssue({
      teamId: params.teamId,
      title: params.title,
      description: params.description,
      priority: params.priority ?? 3, // Default to medium
      labelIds: params.labelIds,
    });

    const issue = await result.issue;
    if (!issue) {
      throw new Error('Failed to create issue');
    }

    const state = await issue.state;
    const team = await issue.team;

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      url: issue.url,
      state: state?.name ?? 'unknown',
      team: team?.name ?? 'unknown',
    };
  }
}

/**
 * Map priority string to Linear priority number.
 * 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low
 */
export function getPriorityNumber(
  priority: 'urgent' | 'high' | 'medium' | 'low'
): number {
  switch (priority) {
    case 'urgent':
      return 1;
    case 'high':
      return 2;
    case 'medium':
      return 3;
    case 'low':
      return 4;
  }
}
