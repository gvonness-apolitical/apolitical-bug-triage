/**
 * Slack API client for bug triage.
 */

import { WebClient } from '@slack/web-api';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logDebug, logWarn } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SlackMessage {
  ts: string;
  text: string;
  user: string;
  threadTs?: string;
  permalink?: string;
}

export interface ReporterProfile {
  userId: string;
  name: string;
  reportCount: number;
  confirmedBugs: number;
  isEngineer: boolean;
  lastReportDate: string;
}

export interface ReporterProfileCache {
  profiles: Record<string, ReporterProfile>;
  lastUpdated: string;
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
      } catch (err) {
        logDebug(`Failed to get permalink for message ${msg.ts}`, err);
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
    } catch (err) {
      logDebug(`Failed to get user name for ${userId}, using ID`, err);
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
    } catch (err) {
      logDebug(`Failed to check triage replies for thread ${threadTs}`, err);
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

  /**
   * Get recent channel messages (for context).
   */
  async getRecentChannelContext(
    channelId: string,
    beforeTs: string,
    limit: number = 5
  ): Promise<SlackMessage[]> {
    try {
      const result = await this.client.conversations.history({
        channel: channelId,
        latest: beforeTs,
        limit,
        inclusive: false,
      });

      const messages: SlackMessage[] = [];
      for (const msg of result.messages ?? []) {
        if (msg.subtype || !msg.text || !msg.ts) continue;
        messages.push({
          ts: msg.ts,
          text: msg.text,
          user: msg.user ?? 'unknown',
          threadTs: msg.thread_ts,
        });
      }
      return messages;
    } catch (err) {
      logDebug(`Failed to get recent channel context for ${channelId}`, err);
      return [];
    }
  }

  /**
   * Get thread replies for a message.
   */
  async getThreadReplies(
    channelId: string,
    threadTs: string
  ): Promise<SlackMessage[]> {
    try {
      const result = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
      });

      const messages: SlackMessage[] = [];
      for (const msg of result.messages ?? []) {
        // Skip the parent message (first one)
        if (msg.ts === threadTs) continue;
        if (!msg.text || !msg.ts) continue;
        messages.push({
          ts: msg.ts,
          text: msg.text,
          user: msg.user ?? 'unknown',
          threadTs: msg.thread_ts,
        });
      }
      return messages;
    } catch (err) {
      logDebug(`Failed to get thread replies for ${threadTs}`, err);
      return [];
    }
  }

  /**
   * Check if user is in an engineering-related group.
   * This is a best-effort check based on Slack user groups.
   */
  async isEngineer(userId: string): Promise<boolean> {
    try {
      // Check user's groups or title
      const result = await this.client.users.info({ user: userId });
      const profile = result.user?.profile;
      const title = profile?.title?.toLowerCase() ?? '';

      const engineeringKeywords = [
        'engineer', 'developer', 'dev', 'sre', 'platform',
        'backend', 'frontend', 'fullstack', 'software',
      ];

      return engineeringKeywords.some(kw => title.includes(kw));
    } catch (err) {
      logDebug(`Failed to check if user ${userId} is an engineer`, err);
      return false;
    }
  }
}

/**
 * Reporter profile manager - tracks reporter history.
 */
export class ReporterProfileManager {
  private cachePath: string;
  private cache: ReporterProfileCache;

  constructor(dataDir?: string) {
    const dir = dataDir ?? join(__dirname, '..', 'data');
    this.cachePath = join(dir, 'reporter-profiles.json');
    this.cache = this.loadCache();
  }

  private loadCache(): ReporterProfileCache {
    try {
      if (existsSync(this.cachePath)) {
        return JSON.parse(readFileSync(this.cachePath, 'utf8'));
      }
    } catch (err) {
      logWarn('Failed to load reporter profile cache, starting fresh', err);
    }
    return {
      profiles: {},
      lastUpdated: new Date().toISOString(),
    };
  }

  private saveCache(): void {
    try {
      this.cache.lastUpdated = new Date().toISOString();
      writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
    } catch (err) {
      console.error('Failed to save reporter profile cache:', err);
    }
  }

  /**
   * Get a reporter's profile.
   */
  getProfile(userId: string): ReporterProfile | null {
    return this.cache.profiles[userId] ?? null;
  }

  /**
   * Update or create a reporter profile.
   */
  updateProfile(
    userId: string,
    name: string,
    options: { isEngineer?: boolean; wasConfirmedBug?: boolean } = {}
  ): ReporterProfile {
    const existing = this.cache.profiles[userId];

    const profile: ReporterProfile = {
      userId,
      name,
      reportCount: (existing?.reportCount ?? 0) + 1,
      confirmedBugs: (existing?.confirmedBugs ?? 0) + (options.wasConfirmedBug ? 1 : 0),
      isEngineer: options.isEngineer ?? existing?.isEngineer ?? false,
      lastReportDate: new Date().toISOString(),
    };

    this.cache.profiles[userId] = profile;
    this.saveCache();
    return profile;
  }

  /**
   * Record that a report was confirmed as a bug.
   */
  recordConfirmedBug(userId: string): void {
    const profile = this.cache.profiles[userId];
    if (profile) {
      profile.confirmedBugs++;
      this.saveCache();
    }
  }

  /**
   * Get reporter accuracy (confirmed bugs / total reports).
   */
  getAccuracy(userId: string): number {
    const profile = this.cache.profiles[userId];
    if (!profile || profile.reportCount === 0) return 0;
    return profile.confirmedBugs / profile.reportCount;
  }

  /**
   * Get all profiles.
   */
  getAllProfiles(): ReporterProfile[] {
    return Object.values(this.cache.profiles);
  }
}
