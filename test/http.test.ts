/**
 * Tests for the platform-free HTTP layer of the Devvit 0.13 server.
 *
 * The web-view server in `src/server/main.ts` is unavoidably tied to
 * `@devvit/web/server` (host primitives unavailable in vitest), but the
 * helpers in `src/server/http.ts` are deliberately platform-free so they
 * CAN be tested. This file covers:
 *
 *   - readJson: empty body / malformed / arrays / objects
 *   - sendJson / sendOk: status, headers, payload
 *   - sendError: AppealError forwarding + generic 500 fallback
 *   - str / num typed field readers
 *   - pathOf: query-string stripping
 *   - dispatch: known routes, 404 on unknown, error handling
 *
 * The point isn't 100 % coverage of `src/server/main.ts` (the route bodies
 * call AppealService and are already exercised by service.test.ts); it's
 * to ensure the HTTP framing — the new code that the migration introduced —
 * is correct and stays correct.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  readJson,
  sendJson,
  sendOk,
  sendError,
  str,
  num,
  pathOf,
  dispatch,
} from '../src/server/http.js';
import { AppealError } from '../src/core/errors/index.js';

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

/** Minimal stand-in for `http.ServerResponse` — captures everything a route
 *  writes so assertions can read it back. */
function mockRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
} {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    statusCode: 0,
    setHeader(k: string, v: string) {
      this._headers[k.toLowerCase()] = v;
    },
    end(payload?: string) {
      this._body = payload ?? '';
      this._status = this.statusCode;
    },
  };
  return res as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
  };
}

/** Tiny readable-stream stand-in that satisfies the `req.on('data'|'end'|'error')`
 *  shape `readJson` relies on. Using `Readable.from` keeps this honest — it's a
 *  real Node stream, not a fake event emitter. */
function mockReq(body: string | null, url = '/api/whoami'): IncomingMessage {
  const stream =
    body === null
      ? Readable.from([] as Buffer[])
      : Readable.from([Buffer.from(body, 'utf8')]);
  // Tack on the request fields `dispatch` reaches for.
  const augmented = stream as unknown as IncomingMessage & { url: string };
  augmented.url = url;
  return augmented;
}

/** Variant that emits an `error` instead of `end`. */
function mockReqError(): IncomingMessage {
  const stream = new Readable({
    read() {
      this.destroy(new Error('connection reset'));
    },
  });
  const augmented = stream as unknown as IncomingMessage & { url: string };
  augmented.url = '/api/whoami';
  return augmented;
}

/* ------------------------------------------------------------------ */
/* readJson                                                            */
/* ------------------------------------------------------------------ */

describe('readJson', () => {
  it('returns {} for an empty body', async () => {
    expect(await readJson(mockReq(''))).toEqual({});
  });

  it('parses a well-formed JSON object', async () => {
    const out = await readJson(mockReq('{"a":1,"b":"two"}'));
    expect(out).toEqual({ a: 1, b: 'two' });
  });

  it('coerces malformed JSON to {} instead of throwing', async () => {
    expect(await readJson(mockReq('not json at all'))).toEqual({});
  });

  it('coerces a JSON array to {} (the routes expect an object body)', async () => {
    expect(await readJson(mockReq('[1,2,3]'))).toEqual({});
  });

  it('coerces a JSON primitive to {}', async () => {
    expect(await readJson(mockReq('42'))).toEqual({});
    expect(await readJson(mockReq('null'))).toEqual({});
    expect(await readJson(mockReq('"a string"'))).toEqual({});
  });

  it('returns {} when the stream errors mid-flight', async () => {
    expect(await readJson(mockReqError())).toEqual({});
  });

  it('trims whitespace before parsing', async () => {
    expect(await readJson(mockReq('   \n  {"x":1}   \n'))).toEqual({ x: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* sendJson / sendOk                                                   */
/* ------------------------------------------------------------------ */

describe('sendJson / sendOk', () => {
  it('writes status, content-type, and JSON payload', () => {
    const res = mockRes();
    sendJson(res, 418, { teapot: true });
    expect(res._status).toBe(418);
    expect(res._headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(res._body)).toEqual({ teapot: true });
  });

  it('sendOk defaults to 200', () => {
    const res = mockRes();
    sendOk(res, { ok: true });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: true });
  });

  it('serialises nested objects faithfully', () => {
    const res = mockRes();
    const payload = { a: [1, 2, { b: 'c' }], n: null };
    sendOk(res, payload);
    expect(JSON.parse(res._body)).toEqual(payload);
  });
});

/* ------------------------------------------------------------------ */
/* sendError                                                           */
/* ------------------------------------------------------------------ */

describe('sendError', () => {
  it('forwards an AppealError using its status and code', () => {
    const res = mockRes();
    sendError(res, new AppealError('VALIDATION_FAILED', 'bad input'));
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toBe('bad input');
  });

  it('uses the AppealError status — 429 for RATE_LIMITED', () => {
    const res = mockRes();
    sendError(res, new AppealError('RATE_LIMITED', 'slow down'));
    expect(res._status).toBe(429);
  });

  it('maps a plain Error to a generic 500 with INTERNAL code', () => {
    const res = mockRes();
    sendError(res, new Error('something exploded'));
    expect(res._status).toBe(500);
    const body = JSON.parse(res._body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe('something exploded');
  });

  it('handles non-Error throwables (strings, numbers) by String()-coercing', () => {
    const res = mockRes();
    sendError(res, 'literal string');
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toEqual({
      error: { code: 'INTERNAL', message: 'literal string' },
    });
  });
});

/* ------------------------------------------------------------------ */
/* str / num                                                           */
/* ------------------------------------------------------------------ */

describe('str / num', () => {
  it('str returns the value when present and a string', () => {
    expect(str({ a: 'hello' }, 'a')).toBe('hello');
  });

  it('str returns "" when the field is missing or non-string', () => {
    expect(str({}, 'a')).toBe('');
    expect(str({ a: 42 }, 'a')).toBe('');
    expect(str({ a: null }, 'a')).toBe('');
    expect(str({ a: undefined }, 'a')).toBe('');
    expect(str({ a: { nested: true } }, 'a')).toBe('');
  });

  it('num returns the value when present and a finite number', () => {
    expect(num({ a: 12 }, 'a', 99)).toBe(12);
    expect(num({ a: 0 }, 'a', 99)).toBe(0);
    expect(num({ a: -3.14 }, 'a', 99)).toBe(-3.14);
  });

  it('num returns the fallback for missing, non-numeric, or non-finite values', () => {
    expect(num({}, 'a', 7)).toBe(7);
    expect(num({ a: 'not a number' }, 'a', 7)).toBe(7);
    expect(num({ a: NaN }, 'a', 7)).toBe(7);
    expect(num({ a: Infinity }, 'a', 7)).toBe(7);
    expect(num({ a: -Infinity }, 'a', 7)).toBe(7);
  });
});

/* ------------------------------------------------------------------ */
/* pathOf                                                              */
/* ------------------------------------------------------------------ */

describe('pathOf', () => {
  it('returns the input verbatim when there is no query string', () => {
    expect(pathOf('/api/foo')).toBe('/api/foo');
  });

  it('strips a query string', () => {
    expect(pathOf('/api/foo?bar=baz')).toBe('/api/foo');
    expect(pathOf('/api/foo?')).toBe('/api/foo');
  });

  it('handles an undefined URL gracefully', () => {
    expect(pathOf(undefined)).toBe('');
  });

  it('handles an empty URL', () => {
    expect(pathOf('')).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

describe('dispatch', () => {
  it('invokes the matching handler with the parsed body', async () => {
    const handler = vi.fn(async (_body: Record<string, unknown>, res: ServerResponse) => {
      sendOk(res, { hit: true });
    });
    const res = mockRes();
    await dispatch(mockReq('{"x":1}', '/api/test'), res, { '/api/test': handler });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({ x: 1 });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ hit: true });
  });

  it('returns 404 with a typed error for an unknown path', async () => {
    const res = mockRes();
    await dispatch(mockReq('{}', '/api/missing'), res, {});
    expect(res._status).toBe(404);
    const body = JSON.parse(res._body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('/api/missing');
  });

  it('strips query string before route lookup', async () => {
    const handler = vi.fn(async (_b: Record<string, unknown>, res: ServerResponse) => {
      sendOk(res, { ok: true });
    });
    const res = mockRes();
    await dispatch(mockReq('{}', '/api/test?cache=1'), res, { '/api/test': handler });
    expect(handler).toHaveBeenCalledOnce();
    expect(res._status).toBe(200);
  });

  it('catches AppealError thrown inside a handler and maps it to its status', async () => {
    const res = mockRes();
    const handler: typeof routes extends Record<string, infer H> ? H : never =
      async () => {
        throw new AppealError('APPEAL_NOT_FOUND', 'no such appeal');
      };
    const routes = { '/api/test': handler };
    await dispatch(mockReq('{}', '/api/test'), res, routes);
    expect(res._status).toBe(404);
    const body = JSON.parse(res._body) as { error: { code: string } };
    expect(body.error.code).toBe('APPEAL_NOT_FOUND');
  });

  it('catches a generic Error in a handler and emits a 500', async () => {
    const res = mockRes();
    await dispatch(
      mockReq('{}', '/api/test'),
      res,
      {
        '/api/test': async () => {
          throw new Error('boom');
        },
      },
    );
    expect(res._status).toBe(500);
    const body = JSON.parse(res._body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe('boom');
  });

  it('respects an injected bodyReader for testing', async () => {
    const res = mockRes();
    const handler = vi.fn(async (body: Record<string, unknown>, r: ServerResponse) => {
      sendOk(r, body);
    });
    await dispatch(
      mockReq('{"ignored":true}', '/api/test'),
      res,
      { '/api/test': handler },
      async () => ({ injected: 'value' }),
    );
    expect(handler.mock.calls[0]?.[0]).toEqual({ injected: 'value' });
    expect(JSON.parse(res._body)).toEqual({ injected: 'value' });
  });

  it('returns 404 for an undefined URL', async () => {
    const res = mockRes();
    const req = mockReq('{}', '/api/test');
    (req as unknown as { url: string | undefined }).url = undefined;
    await dispatch(req, res, { '/api/test': vi.fn() });
    expect(res._status).toBe(404);
  });
});
