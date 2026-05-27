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

  it('throws DUPLICATE_OPEN_APPEAL when a lock blocks submission', async () => {
    const service = new AppealService(store, gateway, new NoopAiProvider());
    await service.submitAppeal(baseInput);
    await expect(service.submitAppeal(baseInput)).rejects.toMatchObject({
      code: 'DUPLICATE_OPEN_APPEAL',
    });
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

  it('throws APPEAL_NOT_FOUND and sends nothing for a missing appeal', async () => {
    await expect(
      service.decide({
        subreddit: 'aww',
        appealId: 'missing',
        decision: 'upheld',
        modId: 'm',
        modName: 'mod',
        note: '',
      }),
    ).rejects.toMatchObject({ code: 'APPEAL_NOT_FOUND' });
    expect(gateway.sent).toHaveLength(0);
  });

  it('records the decision but throws REPLY_DELIVERY_FAILED if delivery fails', async () => {
    // The decision is the source of truth and must persist even when the reply
    // can't be sent; the surface gets a typed error so it can offer a resend.
    const a = await service.submitAppeal(baseInput);
    const failingGateway: RedditGateway = {
      async sendReply() {
        throw new Error('modmail down');
      },
    };
    const svc = new AppealService(store, failingGateway, new NoopAiProvider());
    await expect(
      svc.decide({
        subreddit: 'aww',
        appealId: a.id,
        decision: 'upheld',
        modId: 'm',
        modName: 'mod',
        note: '',
      }),
    ).rejects.toMatchObject({ code: 'REPLY_DELIVERY_FAILED' });
    // The decision still landed.
    const reloaded = await store.get('aww', a.id);
    expect(reloaded!.status).toBe('resolved');
  });

  it('rejects an invalid decision with VALIDATION_FAILED', async () => {
    const a = await service.submitAppeal(baseInput);
    await expect(
      service.decide({
        subreddit: 'aww',
        appealId: a.id,
        decision: 'banhammer' as never,
        modId: 'm',
        modName: 'mod',
        note: '',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('handles a null/undefined note by storing an empty string', async () => {
    const a = await service.submitAppeal(baseInput);
    const decided = await service.decide({
      subreddit: 'aww',
      appealId: a.id,
      decision: 'upheld',
      modId: 'm',
      modName: 'mod',
      note: undefined as unknown as string,
    });
    expect(decided.decisions[0]!.note).toBe('');
  });
});

describe('AppealService.submitAppeal validation', () => {
  it('rejects an invalid submission with VALIDATION_FAILED before storage', async () => {
    const store = new AppealStore(new FakeRedis() as never);
    const gateway = new FakeGateway();
    const service = new AppealService(store, gateway, new NoopAiProvider());
    await expect(
      service.submitAppeal({ ...baseInput, reason: 'too short' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // Nothing was created.
    expect(await store.openCount('aww')).toBe(0);
  });
});

describe('AppealService.queuePage', () => {
  it('delegates to the store and returns a page', async () => {
    const store = new AppealStore(new FakeRedis() as never);
    const service = new AppealService(store, new FakeGateway(), new NoopAiProvider());
    await service.submitAppeal(baseInput);
    const page = await service.queuePage('aww', 10);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
