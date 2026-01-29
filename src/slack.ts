/**
 * Slack API client for bug triage.
 */

import { WebClient } from '@slack/web-api';

export interface SlackMessage {
  ts: string;
  text: string;
  user: string;
  threadTs?: string;
  permalink?: string;
}

export class SlackClient {
  private client: WebClient;

  constructor(token: string) {
    this.client = new WebClient(token);
  }

  /**
   * Fetch messages from a channel since a given timestamp.
   */
  async getMessagesSince(
    channelId: string,
    since: number
  ): Promise<SlackMessage[]> {
    const result = await this.client.conversations.history({
      channel: channelId,
      oldest: since.toString(),
      limit: 100,
    });

    const messages: SlackMessage[] = [];

    for (const msg of result.messages ?? []) {
      // Skip bot messages, join/leave messages, etc.
      if (msg.subtype || !msg.text || !msg.ts) continue;

      // Get permalink for the message
      let permalink: string | undefined;
      try {
        const linkResult = await this.client.chat.getPermalink({
          channel: channelId,
          message_ts: msg.ts,
        });
        permalink = linkResult.permalink;
      } catch {
        // Ignore permalink errors
      }

      messages.push({
        ts: msg.ts,
        text: msg.text,
        user: msg.user ?? 'unknown',
        threadTs: msg.thread_ts,
        permalink,
      });
    }

    return messages;
  }

  /**
   * Get user info by ID.
   */
  async getUserName(userId: string): Promise<string> {
    try {
      const result = await this.client.users.info({ user: userId });
      return result.user?.real_name ?? result.user?.name ?? userId;
    } catch {
      return userId;
    }
  }

  /**
   * Check if a message has a bot reply (to avoid re-triaging).
   */
  async hasTriageReply(channelId: string, threadTs: string): Promise<boolean> {
    try {
      const result = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 10,
      });

      // Check if any reply is from our bot
      // You may want to check for a specific bot user ID or message pattern
      for (const msg of result.messages ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = msg as any;
        if (m.bot_id || m.subtype === 'bot_message') {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Post a reply in a thread.
   */
  async postThreadReply(
    channelId: string,
    threadTs: string,
    text: string
  ): Promise<void> {
    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text,
    });
  }
}
