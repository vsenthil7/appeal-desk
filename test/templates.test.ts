import { describe, it, expect } from 'vitest';
import { renderTemplate, buildReply } from '../src/core/templates.js';
import { DEFAULT_CONFIG, type Appeal } from '../src/core/types.js';

function makeAppeal(overrides: Partial<Appeal> = {}): Appeal {
  return {
    id: 'ap_1',
    subreddit: 'aww',
    actionType: 'ban',
    targetId: 't2_user',
    authorId: 't2_user',
    authorName: 'alice',
    reason: 'please',
    acknowledged: true,
    originalContent: '(account ban)',
    originalReason: 'spam',
    status: 'open',
    triage: { repeatCount: 0 },
    decisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('renderTemplate', () => {
  it('substitutes known variables', () => {
    const out = renderTemplate('Hi {{user}} in r/{{subreddit}}', {
      user: 'alice',
      subreddit: 'aww',
      action: 'ban',
    });
    expect(out).toBe('Hi alice in r/aww');
  });

  it('leaves unknown tokens intact so a mod notices them', () => {
    const out = renderTemplate('Hello {{missing}}', {
      user: 'a',
      subreddit: 'b',
      action: 'ban',
    });
    expect(out).toBe('Hello {{missing}}');
  });

  it('handles templates with no tokens', () => {
    expect(
      renderTemplate('plain text', { user: 'a', subreddit: 'b', action: 'c' }),
    ).toBe('plain text');
  });
});

describe('buildReply', () => {
  it('uses the config template for the given decision', () => {
    const reply = buildReply('overturned', DEFAULT_CONFIG, makeAppeal());
    expect(reply).toBe(DEFAULT_CONFIG.templates.overturned);
  });

  it('renders variables embedded in a custom template', () => {
    const config = {
      ...DEFAULT_CONFIG,
      templates: {
        ...DEFAULT_CONFIG.templates,
        upheld: 'Sorry u/{{user}}, the {{action}} stands.',
      },
    };
    const reply = buildReply('upheld', config, makeAppeal({ authorName: 'bob' }));
    expect(reply).toBe('Sorry u/bob, the ban stands.');
  });
});
