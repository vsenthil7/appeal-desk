/**
 * Context wiring. Builds a fully-configured AppealService from whatever Devvit
 * hands us (a render context, a trigger context, or a scheduler context — all
 * expose `redis` and `reddit`). This is the one place platform objects get
 * adapted to our injectable interfaces, so the core stays Devvit-free.
 *
 * The optional Notifier (W4) is also injected here. The default is the
 * `NoopNotifier`, so production behaviour is unchanged. A deployment that
 * wants Slack/Discord/PagerDuty alerting for SLA breaches constructs its own
 * `Notifier` and replaces the assignment in `makeNotifier` below — every
 * other wiring stays the same.
 */

import type { Devvit, RedisClient } from '@devvit/public-api';
import { AppealStore } from '../core/store.js';
import { AppealService, type RedditGateway } from '../core/service.js';
import {
  ModelAiProvider,
  type AiProvider,
} from '../ai/provider.js';
import { type Notifier, NoopNotifier } from '../core/notifier.js';

/** Anything that carries the two clients we need. */
interface ClientCarrier {
  redis: RedisClient;
  reddit: Devvit.Context['reddit'];
}

/** Adapt Devvit's reddit client to our small RedditGateway interface. */
function makeGateway(reddit: Devvit.Context['reddit']): RedditGateway {
  return {
    async sendReply({ subreddit, to, subject, body }) {
      // A user-facing modmail conversation keeps the exchange on-platform and
      // gives an audit trail. `createConversation` targets a specific user.
      await reddit.modMail.createConversation({
        subredditName: subreddit,
        subject,
        body,
        to,
      });
    },
  };
}

/**
 * Build the optional AI backend. We only construct a model-backed provider if
 * the runtime exposes a text-generation function at `context.ai.generateText`;
 * otherwise we pass `undefined` and the service falls back to the no-op
 * provider automatically. This injection point is forward-looking: the current
 * Devvit SDK does not ship an on-platform text model, so in practice `ai` is
 * absent and Appealdesk runs fully deterministically. When a model backend
 * becomes available (a Devvit AI capability, or one an installer wires in), it
 * is picked up here with no other code changes. Whether AI is actually USED is
 * still gated per-sub by `config.aiEnabled`.
 */
function makeAiBackend(
  context: ClientCarrier & { ai?: { generateText?: (p: string) => Promise<string> } },
): AiProvider | undefined {
  const gen = context.ai?.generateText;
  if (!gen) return undefined;
  return new ModelAiProvider((prompt) => gen(prompt));
}

/**
 * Construct the Notifier (W4). Default is the no-op — wiring a real webhook
 * is one localised change. A deployment swapping this returns its own
 * `Notifier` implementation; everything else stays the same.
 */
function makeNotifier(_context: ClientCarrier): Notifier {
  return new NoopNotifier();
}

export function makeService(
  context: ClientCarrier & {
    ai?: { generateText?: (p: string) => Promise<string> };
  },
): AppealService {
  const store = new AppealStore(context.redis);
  const gateway = makeGateway(context.reddit);
  const ai = makeAiBackend(context);
  const notifier = makeNotifier(context);
  return new AppealService(store, gateway, ai, undefined, notifier);
}

export { AppealStore };
