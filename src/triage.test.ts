import { describe, it, expect } from 'vitest';
import {
  extractKeywords,
  detectContextReferences,
  parseResponse,
} from './triage.js';

describe('extractKeywords', () => {
  it('extracts meaningful words from a message', () => {
    const result = extractKeywords('The login page is broken for all users');
    expect(result).toContain('login');
    expect(result).toContain('page');
    expect(result).toContain('broken');
    expect(result).toContain('users');
  });

  it('removes Slack mentions', () => {
    const result = extractKeywords('Hey <@U12345678> the dashboard is broken');
    expect(result).not.toContain('U12345678');
    expect(result).toContain('dashboard');
    expect(result).toContain('broken');
  });

  it('removes Slack-formatted URLs', () => {
    const result = extractKeywords('Check out <https://example.com|this link> - getting 403 errors');
    expect(result).not.toContain('example');
    expect(result).not.toContain('https');
    expect(result).toContain('check');
    expect(result).toContain('getting');
    expect(result).toContain('errors');
  });

  it('removes plain URLs', () => {
    const result = extractKeywords('Error at https://apolitical.co/events - events page broken');
    expect(result).not.toContain('https');
    expect(result).not.toContain('apolitical');
    expect(result).toContain('error');
    expect(result).toContain('events');
    expect(result).toContain('page');
    expect(result).toContain('broken');
  });

  it('filters out stop words', () => {
    const result = extractKeywords('The page is not working and it should be fixed');
    expect(result).not.toContain('the');
    expect(result).not.toContain('is');
    expect(result).not.toContain('not');
    expect(result).not.toContain('and');
    expect(result).not.toContain('it');
    expect(result).not.toContain('should');
    expect(result).not.toContain('be');
    expect(result).toContain('page');
    expect(result).toContain('working');
    expect(result).toContain('fixed');
  });

  it('filters out short words (< 3 chars)', () => {
    const result = extractKeywords('An API is on it');
    expect(result).not.toContain('an');
    expect(result).not.toContain('is');
    expect(result).not.toContain('on');
    expect(result).not.toContain('it');
    expect(result).toContain('api');
  });

  it('limits output to 8 keywords', () => {
    const result = extractKeywords(
      'authentication login password reset email verification security account profile settings dashboard analytics'
    );
    const words = result.split(' ').filter(w => w.length > 0);
    expect(words.length).toBeLessThanOrEqual(8);
  });

  it('converts to lowercase', () => {
    const result = extractKeywords('ERROR on Dashboard Page');
    expect(result).toContain('error');
    expect(result).toContain('dashboard');
    expect(result).toContain('page');
    expect(result).not.toContain('ERROR');
    expect(result).not.toContain('Dashboard');
  });

  it('handles empty message', () => {
    const result = extractKeywords('');
    expect(result).toBe('');
  });

  it('handles message with only stop words', () => {
    const result = extractKeywords('the is a an and but or');
    expect(result).toBe('');
  });
});

describe('detectContextReferences', () => {
  it('detects "same issue" reference', () => {
    const result = detectContextReferences('This is the same issue we had yesterday');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('same issue reference');
  });

  it('detects "same problem" reference', () => {
    const result = detectContextReferences('Same problem as before');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('same issue reference');
  });

  it('detects "repeat of" reference', () => {
    const result = detectContextReferences('This is a repeat of the earlier bug');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('repeat reference');
  });

  it('detects "happening again" reference', () => {
    const result = detectContextReferences('The login bug is happening again');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('recurrence');
  });

  it('detects "still happening" reference', () => {
    const result = detectContextReferences('The error is still happening');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('ongoing issue');
  });

  it('detects "still broken" reference', () => {
    const result = detectContextReferences('Dashboard is still broken');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('ongoing issue');
  });

  it('detects "as mentioned" reference', () => {
    const result = detectContextReferences('As mentioned above, the API returns 500');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('prior mention');
  });

  it('detects "following up on" reference', () => {
    const result = detectContextReferences('Following up on the search bug');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('follow-up');
  });

  it('detects "see above" reference', () => {
    const result = detectContextReferences('See above for details');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('thread reference');
  });

  it('detects "previous issue" reference', () => {
    const result = detectContextReferences('Related to the previous issue with auth');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('prior issue reference');
  });

  it('detects multiple patterns', () => {
    const result = detectContextReferences('Still broken, same issue as mentioned earlier');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns.length).toBeGreaterThan(1);
    expect(result.patterns).toContain('ongoing issue');
    expect(result.patterns).toContain('same issue reference');
  });

  it('returns false for no references', () => {
    const result = detectContextReferences('Login button returns 403 error');
    expect(result.hasContextReference).toBe(false);
    expect(result.patterns).toHaveLength(0);
  });

  it('is case insensitive', () => {
    const result = detectContextReferences('SAME ISSUE as before');
    expect(result.hasContextReference).toBe(true);
    expect(result.patterns).toContain('same issue reference');
  });

  it('handles empty message', () => {
    const result = detectContextReferences('');
    expect(result.hasContextReference).toBe(false);
    expect(result.patterns).toHaveLength(0);
  });
});

describe('parseResponse', () => {
  it('parses valid JSON response', () => {
    const response = JSON.stringify({
      action: 'new_bug',
      explanation: 'This is a clear bug report.',
      confidence: 'high',
      newTicket: {
        team: 'platform',
        title: 'Login page 403 error',
        description: 'Users getting 403 on login',
        priority: 'high',
      },
    });
    const result = parseResponse(response);
    expect(result.action).toBe('new_bug');
    expect(result.explanation).toBe('This is a clear bug report.');
    expect(result.confidence).toBe('high');
    expect(result.newTicket?.team).toBe('platform');
    expect(result.newTicket?.priority).toBe('high');
  });

  it('parses JSON wrapped in markdown code block', () => {
    const response = `\`\`\`json
{
  "action": "defer",
  "explanation": "Need more context.",
  "confidence": "low"
}
\`\`\``;
    const result = parseResponse(response);
    expect(result.action).toBe('defer');
    expect(result.explanation).toBe('Need more context.');
    expect(result.confidence).toBe('low');
  });

  it('parses JSON wrapped in plain code block', () => {
    const response = `\`\`\`
{
  "action": "not_a_bug",
  "explanation": "This is a feature request.",
  "confidence": "high"
}
\`\`\``;
    const result = parseResponse(response);
    expect(result.action).toBe('not_a_bug');
    expect(result.confidence).toBe('high');
  });

  it('parses existing_ticket action with ticketLink', () => {
    const response = JSON.stringify({
      action: 'existing_ticket',
      explanation: 'This matches an existing ticket.',
      confidence: 'high',
      ticketLink: 'https://linear.app/apolitical/issue/PLT-123',
    });
    const result = parseResponse(response);
    expect(result.action).toBe('existing_ticket');
    expect(result.ticketLink).toBe('https://linear.app/apolitical/issue/PLT-123');
  });

  it('parses needs_info action', () => {
    const response = JSON.stringify({
      action: 'needs_info',
      explanation: 'Can you provide more details?',
      confidence: 'medium',
    });
    const result = parseResponse(response);
    expect(result.action).toBe('needs_info');
    expect(result.confidence).toBe('medium');
  });

  it('throws on missing action field', () => {
    const response = JSON.stringify({
      explanation: 'Missing action',
      confidence: 'high',
    });
    expect(() => parseResponse(response)).toThrow('Missing required fields');
  });

  it('throws on missing explanation field', () => {
    const response = JSON.stringify({
      action: 'defer',
      confidence: 'high',
    });
    expect(() => parseResponse(response)).toThrow('Missing required fields');
  });

  it('throws on missing confidence field', () => {
    const response = JSON.stringify({
      action: 'defer',
      explanation: 'Something',
    });
    expect(() => parseResponse(response)).toThrow('Missing required fields');
  });

  it('throws on invalid action', () => {
    const response = JSON.stringify({
      action: 'invalid_action',
      explanation: 'Something',
      confidence: 'high',
    });
    expect(() => parseResponse(response)).toThrow('Invalid action: invalid_action');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseResponse('not valid json')).toThrow('Failed to parse triage response');
  });

  it('handles whitespace around JSON', () => {
    const response = `
    {
      "action": "defer",
      "explanation": "Something",
      "confidence": "medium"
    }
    `;
    const result = parseResponse(response);
    expect(result.action).toBe('defer');
  });
});
