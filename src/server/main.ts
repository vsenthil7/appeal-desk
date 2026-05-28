/**
 * HTTP server entrypoint for the Devvit 0.13 web view.
 *
 * The custom-post web view served from `client/index.html` makes JSON
 * requests to `/api/*`. This module is the server that handles them.
 *
 * Architecture (mirrors the 0.11/0.12 Blocks shell, just over HTTP):
 *
 *   client web view  -- fetch('/api/...')  -->  this server
 *                                                  |
 *                                                  v
 *                                          makeService(deps)
 *                                                  |
 *                                  AppealStore / AppealService / NoopAi
 *                                                  |
 *                                       Devvit Redis / Reddit modules
 *
 * The `core/` and `ai/` modules import nothing from Devvit, so they're reused
 * verbatim from the legacy shell. Only the adapter layer changes: instead of
 * `context.redis` / `context.reddit`, the new server uses the module-level
 * `redis` and `reddit` imports from `@devvit/web/server`.
 *
 * All endpoints expect POSTed JSON and respond with JSON.
 */

import { createServer, context, redis, reddit, getServerPort } from '@devvit/web/server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppealStore } from '../core/store.js';
import {
  AppealService,
  type RedditGateway,
  type DecideInput,
} from '../core/service.js';
import { NoopNotifier } from '../core/notifier.js';
import { isAppealError } from '../core/errors/index.js';
import type { AppealDecision } from '../core/types.js';
import type { QueueCursor } from '../core/store.js';

/* -------------------------------------------------------------------------
 * Reddit gateway adapter
 *
 * The service expects a small `RedditGateway` with `sendReply`. The new
 * module-level `reddit` from `@devvit/web/server` exposes `modMail` directly
 * (no context wrapper), so the adapter is a thin shim around that.
 * ----------------------------------------------------------------------- */

const gateway: RedditGateway = {
  async sendReply({ subreddit, to, subject, body }) {
    await reddit.modMail.createConversation({
      subredditName: subreddit,
      subject,
      body,
      to,
    });
  },
};

/* -------------------------------------------------------------------------
 * Service construction
 *
 * Cheap to call per request. The store wraps the module-level `redis` (which
 * structurally satisfies `RedisLike`). The AI provider is intentionally absent
 * here — the `NoopAiProvider` selected by `selectProvider(false, undefined)`
 * inside the service is the right default, and the AI runtime hook that the
 * legacy Blocks shell used (`context.ai.generateText`) does not have an
 * `@devvit/web/server` equivalent in 0.13.0 (yet). The product still works
 * end-to-end with AI off — that's the whole point of the no-op default.
 * ----------------------------------------------------------------------- */

function makeService(): AppealService {
  const store = new AppealStore(redis);
  return new AppealService(
    store,
    gateway,
    undefined, // no AI backend wired in the 0.13 web shell
    undefined, // default telemetry
    new NoopNotifier(),
  );
}

/* -------------------------------------------------------------------------
 * Tiny HTTP helpers
 * ----------------------------------------------------------------------- */

/** Read a JSON body (or `{}` if absent / malformed). */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendOk(res: ServerResponse, body: unknown): void {
  sendJson(res, 200, body);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (isAppealError(err)) {
    // AppealError exposes `status`, not `statusCode`. See core/errors/index.ts.
    sendJson(res, err.status, {
      error: { code: err.code, message: err.message },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: 'INTERNAL', message } });
}

/** Pick a string field from a parsed body. */
function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

/** Pick a number field. */
function num(body: Record<string, unknown>, key: string, fallback: number): number {
  const v = body[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* -------------------------------------------------------------------------
 * Routes
 * ----------------------------------------------------------------------- */

interface RouteContext {
  service: AppealService;
  subreddit: string;
  userId: string;
  username: string;
}

function buildRouteContext(): RouteContext {
  return {
    service: makeService(),
    subreddit: context.subredditName ?? '',
    userId: context.userId ?? 'unknown',
    username: context.username ?? 'unknown',
  };
}

async function routeAppealsList(
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const rc = buildRouteContext();
  const limit = Math.min(100, Math.max(1, num(body, 'limit', 25)));
  const cursor = body.cursor as QueueCursor | undefined;
  const page = await rc.service.queuePage(rc.subreddit, limit, cursor);
  const count = await rc.service.openCount(rc.subreddit);
  sendOk(res, {
    items: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.nextCursor !== null,
    openCount: count,
  });
}

async function routeAppealOpen(
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const rc = buildRouteContext();
  const id = str(body, 'appealId');
  if (!id) {
    sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'appealId required' } });
    return;
  }
  const appeal = await rc.service.open(rc.subreddit, id);
  sendOk(res, { appeal });
}

async function routeSuggestReply(
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const rc = buildRouteContext();
  const id = str(body, 'appealId');
  const decision = str(body, 'decision') as AppealDecision;
  if (!id || !decision) {
    sendJson(res, 400, {
      error: { code: 'VALIDATION_FAILED', message: 'appealId + decision required' },
    });
    return;
  }
  const suggested = await rc.service.suggestReply(rc.subreddit, id, decision);
  sendOk(res, { suggested });
}

async function routeDecide(
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const rc = buildRouteContext();
  const input: DecideInput = {
    subreddit: rc.subreddit,
    appealId: str(body, 'appealId'),
    decision: (str(body, 'decision') as AppealDecision) || 'upheld',
    modId: rc.userId,
    modName: rc.username,
    note: str(body, 'note'),
    finalReply: str(body, 'finalReply') || undefined,
  };
  if (!input.appealId) {
    sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'appealId required' } });
    return;
  }
  try {
    const decided = await rc.service.decide(input);
    sendOk(res, { appeal: decided, replySent: true });
  } catch (err) {
    if (isAppealError(err) && err.code === 'REPLY_DELIVERY_FAILED') {
      // The decision IS recorded; only the reply failed. Surface that.
      sendJson(res, 200, {
        appeal: null,
        replySent: false,
        error: { code: err.code, message: err.message },
      });
      return;
    }
    sendError(res, err);
  }
}

async function routeClaim(
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const rc = buildRouteContext();
  const id = str(body, 'appealId');
  if (!id) {
    sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'appealId required' } });
    return;
  }
  const appeal = await rc.service.claim(rc.subreddit, id, rc.userId, rc.username);
  sendOk(res, { appeal });
}

async function routeUnclaim(
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const rc = buildRouteContext();
  const id = str(body, 'appealId');
  if (!id) {
    sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'appealId required' } });
    return;
  }
  const appeal = await rc.service.unclaim(rc.subreddit, id, rc.userId);
  sendOk(res, { appeal });
}

async function routeErase(
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const rc = buildRouteContext();
  const id = str(body, 'appealId');
  if (!id) {
    sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'appealId required' } });
    return;
  }
  const appeal = await rc.service.eraseAppeal(rc.subreddit, id);
  sendOk(res, { appeal });
}

async function routeAnalytics(
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const rc = buildRouteContext();
  const windowDays = Math.min(365, Math.max(1, num(body, 'windowDays', 30)));
  const data = await rc.service.analytics(rc.subreddit, windowDays);
  sendOk(res, { analytics: data });
}

async function routeWhoami(
  _body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const rc = buildRouteContext();
  sendOk(res, {
    subreddit: rc.subreddit,
    userId: rc.userId,
    username: rc.username,
  });
}

/* -------------------------------------------------------------------------
 * Dispatcher
 * ----------------------------------------------------------------------- */

type Handler = (body: Record<string, unknown>, res: ServerResponse) => Promise<void>;

const routes: Record<string, Handler> = {
  '/api/appeals/list': routeAppealsList,
  '/api/appeals/open': routeAppealOpen,
  '/api/appeals/suggest-reply': routeSuggestReply,
  '/api/appeals/decide': routeDecide,
  '/api/appeals/claim': routeClaim,
  '/api/appeals/unclaim': routeUnclaim,
  '/api/appeals/erase': routeErase,
  '/api/analytics': routeAnalytics,
  '/api/whoami': routeWhoami,
};

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? '';
    // Strip any query string so /api/foo?bar=baz still routes to /api/foo.
    const path = url.split('?')[0] ?? '';
    const handler = routes[path];
    if (!handler) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${path}` } });
      return;
    }
    const body = await readJson(req);
    await handler(body, res);
  } catch (err) {
    sendError(res, err);
  }
});

server.listen(getServerPort());
