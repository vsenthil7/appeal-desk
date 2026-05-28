/**
 * Pure HTTP helpers for the Devvit-0.13 web view server.
 *
 * Extracted from `src/server/main.ts` so it can be unit-tested without
 * pulling in `@devvit/web/server` (which is a host-only runtime import,
 * unavailable inside vitest). Everything here is platform-free:
 *   - body parsing
 *   - JSON response framing
 *   - typed field readers
 *   - the route dispatcher
 *
 * `src/server/main.ts` is the thin wiring layer that imports the host
 * primitives and calls into this module.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAppealError } from '../core/errors/index.js';

/* -------------------------------------------------------------------------
 * Body parsing
 * ----------------------------------------------------------------------- */

/**
 * Read a JSON body from an IncomingMessage. Returns `{}` on absent / malformed
 * input — the per-route handlers do their own field validation, so we don't
 * fail the request just because the body shape isn't quite right at this
 * layer.
 */
export function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
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

/* -------------------------------------------------------------------------
 * Response helpers
 * ----------------------------------------------------------------------- */

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function sendOk(res: ServerResponse, body: unknown): void {
  sendJson(res, 200, body);
}

/**
 * Surface an error as JSON. `AppealError` instances carry a stable `code` and
 * an HTTP-ish `status` field, which we forward; everything else maps to a
 * generic 500 with the message preserved for log triage.
 */
export function sendError(res: ServerResponse, err: unknown): void {
  if (isAppealError(err)) {
    sendJson(res, err.status, {
      error: { code: err.code, message: err.message },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: 'INTERNAL', message } });
}

/* -------------------------------------------------------------------------
 * Typed body field readers
 *
 * Tiny but useful — the routes don't have to repeat the `typeof v === 'string'`
 * dance for every field, and undefined-vs-non-string fall through to a
 * predictable empty value.
 * ----------------------------------------------------------------------- */

export function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

export function num(body: Record<string, unknown>, key: string, fallback: number): number {
  const v = body[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* -------------------------------------------------------------------------
 * Route dispatcher
 *
 * Maps `req.url`'s path component to a handler. Query strings are stripped so
 * `/api/foo?bar=baz` still routes to `/api/foo`. Unknown paths get a 404 with
 * a typed error body.
 * ----------------------------------------------------------------------- */

export type Handler = (
  body: Record<string, unknown>,
  res: ServerResponse,
) => Promise<void>;

export type RouteTable = Record<string, Handler>;

/** Pull the path out of a request URL, dropping any query string. */
export function pathOf(url: string | undefined): string {
  const u = url ?? '';
  const q = u.indexOf('?');
  return q < 0 ? u : u.slice(0, q);
}

/**
 * Dispatch a single request. Returns a promise that resolves once the response
 * has been written. Caller passes the request, response, the routes map, and
 * a function that reads the body — splitting that out keeps the dispatcher
 * unit-testable without setting up a real `IncomingMessage` stream.
 */
export async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  routes: RouteTable,
  bodyReader: (req: IncomingMessage) => Promise<Record<string, unknown>> = readJson,
): Promise<void> {
  try {
    const path = pathOf(req.url);
    const handler = routes[path];
    if (!handler) {
      sendJson(res, 404, {
        error: { code: 'NOT_FOUND', message: `No route for ${path}` },
      });
      return;
    }
    const body = await bodyReader(req);
    await handler(body, res);
  } catch (err) {
    sendError(res, err);
  }
}
