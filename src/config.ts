/**
 * Configuration for bug triage.
 */

export interface Config {
  /** Slack channel ID for #bug-hunt */
  slackChannelId: string;

  /** Linear team IDs for ticket creation */
  linearTeams: {
    platform: string;
    enterprise: string;
    ai: string;
    data: string;
  };

  /** Linear label ID for bugs */
  linearBugLabelId: string;

  /** Claude model to use */
  claudeModel: string;

  /** Dry run mode - read only, no writes */
  dryRun: boolean;

  /** Verbose logging */
  verbose: boolean;
}

// Default configuration
// TODO: These IDs need to be filled in from your Linear workspace
export const defaultConfig: Omit<Config, 'dryRun' | 'verbose'> = {
  slackChannelId: 'C3W35V43D', // #bug-hunt
  linearTeams: {
    platform: 'c96481ee-5e8b-4622-961a-b3502a1e8644',
    enterprise: 'af99ba78-20d8-4e31-93b9-f73dceac6aa3',
    ai: 'e3a47de3-09a2-4306-b13f-f133c308aaab', // AI Tools - can also use AI Learning: d065a65a-73cc-4043-a45f-a82f02471c5f
    data: '31a0e6e6-b43e-4549-94a6-0ab61b8edf27',
  },
  linearBugLabelId: '25de1f1f-e394-49a0-a6a5-8f8677eefb68', // "type: bug 🐛"
  claudeModel: 'claude-sonnet-4-20250514', // Use Sonnet for testing, switch to Opus for production
};

/**
 * Team keywords for routing bugs to the right team.
 */
export const teamKeywords: Record<string, string[]> = {
  platform: [
    'gke',
    'kubernetes',
    'k8s',
    'deployment',
    'ci',
    'cd',
    'pipeline',
    'infrastructure',
    'cloud run',
    'terraform',
    'helm',
    'docker',
    'database',
    'postgres',
    'redis',
    'performance',
    'latency',
    'timeout',
    'memory',
    'cpu',
    'scaling',
    'auth0',
    'authentication',
    'openfga',
    'authorization',
  ],
  enterprise: [
    'academy',
    'academies',
    'cohort',
    'admin',
    'admin-ui',
    'admin-api',
    'enterprise',
    'b2b',
    'white-label',
    'sso',
    'saml',
  ],
  ai: [
    'ai',
    'llm',
    'gpt',
    'claude',
    'gemini',
    'futura',
    'curriculum',
    'learning track',
    'ai feedback',
    'moderation',
    'chatbot',
    'assistant',
  ],
  data: [
    'dbt',
    'bigquery',
    'thoughtspot',
    'analytics',
    'reporting',
    'dashboard',
    'metrics',
    'data pipeline',
    'etl',
  ],
};
