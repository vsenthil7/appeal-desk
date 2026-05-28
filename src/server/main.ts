/**
 * HTTP server entrypoint for the Devvit 0.13 web view.
 *
 * The custom-post web view served from `client/index.html` makes JSON
 * requests to `/api/*`. This module is the server that handles them.
 *
 * Also serves `/internal/menu/*` endpoints declared in `devvit.json` for
 * menu items that can't run in the Blocks runtime (anything needing the
 * server-side reddit client, e.g. `submitCustomPost`).
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
 * `redis` and `reddit` imports from the underlying `@devvit/*` sub-packages.
 *
 * NOTE on imports: this file deliberately imports from `@devvit/server`,
 * `@devvit/reddit`, `@devvit/redis` directly, NOT from the `@devvit/web/server`
 * barrel. The Devvit host runtime resolves the individual sub-packages but
 * does NOT resolve the `@devvit/web/server` barrel name — apps using the
 * barrel name fail at install time with "Cannot find module '@devvit/web/server'".
 * Imports here match the barrel's own re-export tree (see
 * `node_modules/@devvit/web/server/index.d.ts`).
 *
 * The HTTP framing (body parsing, JSON responses, route dispatch) is in the
 * platform-free `./http.js` so it can be unit-tested without pulling in the
 * Devvit host runtime. This file is the thin wiring layer.
 */

import { createServer, context, getServerPort } from '@devvit/server';
import { redis } from '@devvit/redis';
import { reddit } from '@devvit/reddit';
import type { ServerResponse } from 'node:http';
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
import {
  dispatch,
  sendJson,
  sendOk,
  sendError,
  str,
  num,
  type RouteTable,
} from './http.js';

/* -------------------------------------------------------------------------
 * Reddit gateway adapter
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
 * structurally satisfies `RedisLike`). The AI provider is intentionally
 * absent here — the `NoopAiProvider` selected by `selectProvider(false,
 * undefined)` inside the service is the right default, and the AI runtime
 * hook that the legacy Blocks shell used (`context.ai.generateText`) does
 * not have a 0.13 server-side equivalent yet.
 * ----------------------------------------------------------------------- */

function makeService(): AppealService {
  const store = new AppealStore(redis);
  return new AppealService(store, gateway, undefined, undefined, new NoopNotifier());
}

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

/* -------------------------------------------------------------------------
 * /api/* routes — called by the web view
 * ----------------------------------------------------------------------- */

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
 * /internal/menu/* routes — called by Devvit when a JSON-config menu item
 * is tapped.
 *
 * Response shape per the CLI's blocks.template.js `validateUiResponse`:
 *
 *   { showToast?: string | { text, appearance? },
 *     navigateTo?: string | Post,
 *     showForm?: { name, data?, form? } }
 *
 * Flat object, NOT the `ContextActionResponse` proto shape. Only these
 * three keys are valid; `navigateTo` and `showForm` are mutually exclusive.
 * ----------------------------------------------------------------------- */

async function routeMenuCreateDashboard(
  _body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const subredditName = context.subredditName;
  if (!subredditName) {
    sendJson(res, 400, {
      error: { code: 'VALIDATION_FAILED', message: 'no subreddit in context' },
    });
    return;
  }
  try {
    const post = await reddit.submitCustomPost({
      subredditName,
      title: 'Appeal-Desk - Appeals Dashboard (mods only)',
      textFallback: {
        text: 'Open the Appeals Dashboard to triage open appeals.',
      },
    });
    try {
      await post.sticky();
    } catch {
      // Non-fatal — the post still exists, just not pinned.
    }
    // UiResponse shape: flat object, only `showToast` / `navigateTo` /
    // `showForm` keys allowed.
    sendOk(res, {
      showToast: {
        text: 'Appeals Dashboard created and pinned.',
        appearance: 'success',
      },
      navigateTo: post.url ?? post.permalink ?? `https://www.reddit.com/r/${subredditName}/`,
    });
  } catch (err) {
    sendError(res, err);
  }
}

/* -------------------------------------------------------------------------
 * Wire up + start
 * ----------------------------------------------------------------------- */

export const routes: RouteTable = {
  // Web-view API
  '/api/appeals/list': routeAppealsList,
  '/api/appeals/open': routeAppealOpen,
  '/api/appeals/suggest-reply': routeSuggestReply,
  '/api/appeals/decide': routeDecide,
  '/api/appeals/claim': routeClaim,
  '/api/appeals/unclaim': routeUnclaim,
  '/api/appeals/erase': routeErase,
  '/api/analytics': routeAnalytics,
  '/api/whoami': routeWhoami,
  // Internal menu endpoints (called by Devvit when a JSON-config menu item is tapped)
  '/internal/menu/create-dashboard': routeMenuCreateDashboard,
};

const server = createServer((req, res) => dispatch(req, res, routes));

server.listen(getServerPort());
