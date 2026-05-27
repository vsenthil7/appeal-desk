import { describe, it, expect, beforeEach } from 'vitest';
import { FakeRedis } from './helpers/fakeRedis.js';
import { AppealStore } from '../src/core/store.js';
import { AppealService, type RedditGateway } from '../src/core/service.js';
import { DEFAULT_CONFIG } from '../src/core/types.js';
import { NoopAiProvider, ModelAiProvider } from '../src/ai/provider.js';

interface SentReply {
  subreddit: string;
  to: string;
  subject: string;
  body: string;
}

class FakeGateway implements RedditGateway {
  sent: SentReply[] = [];
  async sendReply(args: SentReply): Promise<void> {
    this.sent.push(args);
  }
}

const baseInput = {
  subreddit: 'aww',
  actionType: 'ban' as const,
  targetId: 't2_alice',
  authorId: 't2_alice',
  authorName: 'alice',
  reason: 'please reconsider this ban, it was a misunderstanding',
  acknowledged: true,
  originalContent: '(account ban)',
  originalReason: 'spam',
};

describe('AppealService.submitAppeal', () => {
  let redis: FakeRedis;
  let store: AppealStore;
  let gateway: FakeGateway;

  beforeEach(() => {
    redis = new FakeRedis();
    store = new AppealStore(redis as never);
    gateway = new FakeGateway();
  });

  it('creates an appeal and runs no AI when disabled', async () => {
    const service = new AppealService(store, gateway, new NoopAiProvider());
    const a = await service.submitAppeal(baseInput);
    expect(a).not.toBeNull();
    expect(a!.triage.model).toBeUndefined();
  });

  it('attaches an AI label when the sub has AI enabled', async () => {
    await store.setConfig('aww', { ...DEFAULT_CONFIG, aiEnabled: true });
    const ai = new ModelAiProvider(async () =>
      '{"label":"likely_genuine","confidence":0.8,"rationale":"sincere"}',
    );
    const service = new AppealService(store, gateway, ai);
    const a = await service.submitAppeal(baseInput);
    const reloaded = await store.get('aww', a!.id);
    expect(reloaded!.triage.model?.label).toBe('likely_genuine');
  });

  it('does not attach a label when AI is enabled but the model declines', async () => {
    await store.setConfig('aww', { ...DEFAULT_CONFIG, aiEnabled: true });
    const ai = new ModelAiProvider(async () => 'no json');
    const service = new AppealService(store, gateway, ai);
    const a = await service.submitAppeal(baseInput);
    const reloaded = await store.get('aww', a!.id);
    expect(reloaded!.triage.model).toBeUndefined();
  });

  it('returns null when a duplicate-open lock blocks submission', async () => {
    const service = new AppealService(store, gateway, new NoopAiProvider());
    await service.submitAppeal(baseInput);
    expect(await service.submitAppeal(baseInput)).toBeNull();
  });
});

describe('AppealService.queue / open', () => {
  it('lists the queue and marks an appeal in review when opened', async () => {
    const store = new AppealStore(new FakeRedis() as never);
    const service = new AppealService(store, new FakeGateway(), new NoopAiProvider());
    const a = await service.submitAppeal(baseInput);
    expect((await service.queue('aww')).map((q) => q.id)).toContain(a!.id);
    const opened = await service.open('aww', a!.id);
    expect(opened!.status).toBe('in_review');
  });
});

describe('AppealService.suggestReply', () => {
  let store: AppealStore;
  let service: AppealService;
  beforeEach(() => {
    store = new AppealStore(new FakeRedis() as never);
  });

  it('returns empty string for a missing appeal', async () => {
    service = new AppealService(store, new FakeGateway(), new NoopAiProvider());
    expect(await service.suggestReply('aww', 'missing', 'upheld')).toBe('');
  });

  it('returns the plain template when AI is off', async () => {
    service = new AppealService(store, new FakeGateway(), new NoopAiProvider());
    const a = await service.submitAppeal(baseInput);
    const reply = await service.suggestReply('aww', a!.id, 'upheld');
    expect(reply).toBe(DEFAULT_CONFIG.templates.upheld);
  });

  it('returns the AI-softened template when AI is on', async () => {
    await store.setConfig('aww', { ...DEFAULT_CONFIG, aiEnabled: true });
    const ai = new ModelAiProvider(async (p) =>
      p.includes('Rewrite') ? 'A kinder version.' : 'unused',
    );
    service = new AppealService(store, new FakeGateway(), ai);
    const a = await service.submitAppeal(baseInput);
    const reply = await service.suggestReply('aww', a!.id, 'overturned');
    expect(reply).toBe('A kinder version.');
  });
});

describe('AppealService.decide', () => {
  let redis: FakeRedis;
  let store: AppealStore;
  let gateway: FakeGateway;
  let service: AppealService;
  beforeEach(() => {
    redis = new FakeRedis();
    store = new AppealStore(redis as never);
    gateway = new FakeGateway();
    service = new AppealService(store, gateway, new NoopAiProvider());
  });

  it('records the decision and sends the templated reply', async () => {
    const a = await service.submitAppeal(baseInput);
    const decided = await service.decide({
      subreddit: 'aww',
      appealId: a!.id,
      decision: 'upheld',
      modId: 'm1',
      modName: 'mod',
      note: 'clear spam',
    });
    expect(decided!.status).toBe('resolved');
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]!.to).toBe('alice');
    expect(gateway.sent[0]!.body).toBe(DEFAULT_CONFIG.templates.upheld);
  });

  it('sends the mod-edited reply when finalReply is supplied', async () => {
    const a = await service.submitAppeal(baseInput);
    await service.decide({
      subreddit: 'aww',
      appealId: a!.id,
      decision: 'overturned',
      modId: 'm1',
      modName: 'mod',
      note: '',
      finalReply: 'Custom reply from the mod.',
    });
    expect(gateway.sent[0]!.body).toBe('Custom reply from the mod.');
  });

  it('returns null and sends nothing for a missing appeal', async () => {
    const decided = await service.decide({
      subreddit: 'aww',
      appealId: 'missing',
      decision: 'upheld',
      modId: 'm',
      modName: 'mod',
      note: '',
    });
    expect(decided).toBeNull();
    expect(gateway.sent).toHaveLength(0);
  });

  it('returns null without sending if the appeal vanishes between read and decide', async () => {
    // Simulate a TOCTOU race: get() finds the appeal, but decide() then finds
    // it gone (e.g. concurrently resolved/deleted). The reply must NOT be sent.
    const a = await service.submitAppeal(baseInput);
    const racingStore = Object.create(store) as AppealStore;
    racingStore.decide = async () => null; // decide loses the race
    const racingService = new AppealService(
      racingStore,
      gateway,
      new NoopAiProvider(),
    );
    const decided = await racingService.decide({
      subreddit: 'aww',
      appealId: a!.id,
      decision: 'upheld',
      modId: 'm',
      modName: 'mod',
      note: '',
    });
    expect(decided).toBeNull();
    expect(gateway.sent).toHaveLength(0);
  });
});
