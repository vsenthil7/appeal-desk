import { describe, it, expect } from 'vitest';
import {
  NoopAiProvider,
  ModelAiProvider,
  selectProvider,
  buildTriagePrompt,
  buildSoftenPrompt,
  parseTriage,
} from '../src/ai/provider.js';
import type { Appeal } from '../src/core/types.js';

function makeAppeal(overrides: Partial<Appeal> = {}): Appeal {
  return {
    id: 'ap_1',
    subreddit: 'aww',
    actionType: 'removal',
    targetId: 't3_x',
    authorId: 't2_u',
    authorName: 'alice',
    reason: 'this was a mistake',
    acknowledged: false,
    originalContent: 'some post',
    originalReason: 'rule 3',
    status: 'open',
    triage: { repeatCount: 1, duplicateOfAppealId: 'ap_old' },
    decisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('NoopAiProvider', () => {
  it('never triages and returns drafts unchanged', async () => {
    const p = new NoopAiProvider();
    expect(await p.triage()).toBeNull();
    expect(await p.softenReply('hello')).toBe('hello');
  });
});

describe('selectProvider', () => {
  const backend = new NoopAiProvider();
  it('uses the backend only when enabled AND a backend exists', () => {
    expect(selectProvider(true, backend)).toBe(backend);
  });
  it('falls back to noop when disabled', () => {
    expect(selectProvider(false, backend)).toBeInstanceOf(NoopAiProvider);
    expect(selectProvider(false, backend)).not.toBe(backend);
  });
  it('falls back to noop when no backend is provided', () => {
    expect(selectProvider(true, undefined)).toBeInstanceOf(NoopAiProvider);
  });
});

describe('prompt builders', () => {
  it('triage prompt includes the appeal facts and the no-decision instruction', () => {
    const prompt = buildTriagePrompt(makeAppeal());
    expect(prompt).toContain('do NOT make decisions');
    expect(prompt).toContain('rule 3');
    expect(prompt).toContain('Prior appeals by this user in this sub: 1');
    expect(prompt).toContain('Deterministic duplicate match: yes');
    expect(prompt).toContain('User acknowledged the rule: no');
  });

  it('triage prompt reflects no-duplicate and acknowledged cases', () => {
    const prompt = buildTriagePrompt(
      makeAppeal({
        acknowledged: true,
        triage: { repeatCount: 0, duplicateOfAppealId: undefined },
      }),
    );
    expect(prompt).toContain('Deterministic duplicate match: no');
    expect(prompt).toContain('User acknowledged the rule: yes');
  });

  it('soften prompt preserves the decision and forbids new promises', () => {
    const prompt = buildSoftenPrompt('Your ban stands.', makeAppeal());
    expect(prompt).toContain('WITHOUT changing the decision');
    expect(prompt).toContain('Your ban stands.');
  });
});

describe('parseTriage', () => {
  it('parses a clean JSON object', () => {
    const r = parseTriage(
      '{"label":"likely_genuine","confidence":0.8,"rationale":"seems sincere"}',
    );
    expect(r).toEqual({
      label: 'likely_genuine',
      confidence: 0.8,
      rationale: 'seems sincere',
    });
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const r = parseTriage(
      'Sure! {"label":"likely_abusive","confidence":2,"rationale":"slurs"} done',
    );
    expect(r?.label).toBe('likely_abusive');
    expect(r?.confidence).toBe(1); // clamped to [0,1]
  });

  it('clamps NaN/negative confidence to 0 and missing rationale to empty', () => {
    const r = parseTriage('{"label":"likely_duplicate","confidence":"x"}');
    expect(r).toEqual({
      label: 'likely_duplicate',
      confidence: 0,
      rationale: '',
    });
  });

  it('truncates an over-long rationale', () => {
    const long = 'a'.repeat(500);
    const r = parseTriage(
      `{"label":"likely_genuine","confidence":0.5,"rationale":"${long}"}`,
    );
    expect(r?.rationale.length).toBe(240);
  });

  it('returns null for no JSON, bad JSON, and invalid labels', () => {
    expect(parseTriage('no json here')).toBeNull();
    expect(parseTriage('{not valid json}')).toBeNull();
    expect(parseTriage('{"label":"banned_them","confidence":1}')).toBeNull();
  });
});

describe('ModelAiProvider', () => {
  it('returns a parsed triage label from the model', async () => {
    const p = new ModelAiProvider(async () =>
      '{"label":"likely_genuine","confidence":0.9,"rationale":"ok"}',
    );
    const r = await p.triage(makeAppeal());
    expect(r?.label).toBe('likely_genuine');
  });

  it('returns null when the model throws (degrade silently)', async () => {
    const p = new ModelAiProvider(async () => {
      throw new Error('model down');
    });
    expect(await p.triage(makeAppeal())).toBeNull();
  });

  it('returns null when the model output is unparseable', async () => {
    const p = new ModelAiProvider(async () => 'garbage');
    expect(await p.triage(makeAppeal())).toBeNull();
  });

  it('softens a reply within length bounds', async () => {
    const p = new ModelAiProvider(async () => '  A calmer reply.  ');
    expect(await p.softenReply('Your ban stands.', makeAppeal())).toBe(
      'A calmer reply.',
    );
  });

  it('falls back to the draft when softening returns empty', async () => {
    const p = new ModelAiProvider(async () => '   ');
    expect(await p.softenReply('original', makeAppeal())).toBe('original');
  });

  it('falls back to the draft when softening is absurdly long', async () => {
    const p = new ModelAiProvider(async () => 'x'.repeat(1000));
    expect(await p.softenReply('short', makeAppeal())).toBe('short');
  });

  it('falls back to the draft when the model throws during softening', async () => {
    const p = new ModelAiProvider(async () => {
      throw new Error('boom');
    });
    expect(await p.softenReply('keep me', makeAppeal())).toBe('keep me');
  });
});
