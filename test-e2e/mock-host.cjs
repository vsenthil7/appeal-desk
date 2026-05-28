/**
 * Mock host for the Appeal-Desk web view, used by the Playwright e2e test.
 *
 * Serves the real `client/` static assets (index.html, app.js, styles.css)
 * and stubs the `/api/*` endpoints with deterministic fixture data — exactly
 * the JSON shapes `src/server/main.ts` produces, so the client code under
 * test is byte-for-byte the production client.
 *
 * This isolates "is our web-view UI correct?" from "is Devvit's iframe host
 * serving it?" — the blank-box bug we hit was the latter (a Devvit CLI
 * 0.13.0 hosting bug), and this harness proves the former is sound.
 *
 * Run standalone: `node test-e2e/mock-host.cjs [port]`
 * Or let the Playwright config boot it via webServer.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const PORT = Number(process.argv[2] || process.env.PORT || 7331);

/* ----------------------------------------------------------------------- */
/* Fixture data — mirrors the core/types shapes the real server returns.   */
/* ----------------------------------------------------------------------- */

const now = Date.now();

function makeAppeal(over) {
  return {
    id: 'ap_1',
    subreddit: 'appeal_desk_dev',
    authorId: 't2_user1',
    authorName: 'alice',
    actionType: 'comment_removal',
    status: 'open',
    reason: 'I believe my comment followed the rules; it was on-topic and civil.',
    acknowledged: true,
    originalContent: 'The removed comment text goes here.',
    originalReason: 'Rule 3: stay on topic',
    permalink: '/r/appeal_desk_dev/comments/abc/xyz/',
    ruleId: 'rule-3',
    repeatCount: 0,
    assignedModId: null,
    assignedModName: null,
    createdAt: now - 5 * 60000,
    updatedAt: now - 5 * 60000,
    decisions: [],
    triage: { repeatCount: 0 },
    ...over,
  };
}

const QUEUE = [
  makeAppeal({ id: 'ap_1', authorName: 'alice', repeatCount: 0 }),
  makeAppeal({
    id: 'ap_2',
    authorName: 'bob',
    actionType: 'ban',
    ruleId: 'rule-1',
    repeatCount: 2,
    createdAt: now - 30 * 60000,
  }),
  makeAppeal({
    id: 'ap_3',
    authorName: 'carol',
    actionType: 'removal',
    assignedModId: 't2_mod9',
    assignedModName: 'modnine',
    createdAt: now - 2 * 60 * 60000,
  }),
];

const ANALYTICS = {
  windowDays: 30,
  openCount: 3,
  resolvedInWindow: 12,
  overturnedInWindow: 4,
  medianTimeToDecisionMs: 3 * 60 * 60000,
  topRulesOverturned: [
    { ruleId: 'rule-3', count: 3 },
    { ruleId: 'rule-1', count: 1 },
  ],
  topOriginalReasonsOverturned: [],
  byActionType: [
    { actionType: 'comment_removal', count: 7 },
    { actionType: 'removal', count: 3 },
    { actionType: 'ban', count: 2 },
  ],
};

/* ----------------------------------------------------------------------- */
/* API handlers                                                            */
/* ----------------------------------------------------------------------- */

const api = {
  '/api/whoami': () => ({
    subreddit: 'appeal_desk_dev',
    userId: 't2_modme',
    username: 'modme',
  }),
  '/api/appeals/list': () => ({
    items: QUEUE,
    nextCursor: null,
    hasMore: false,
    openCount: QUEUE.length,
  }),
  '/api/appeals/open': (body) => {
    const found = QUEUE.find((a) => a.id === body.appealId) || makeAppeal({ id: body.appealId });
    return {
      appeal: {
        ...found,
        decisions: [],
        triage: {
          repeatCount: found.repeatCount || 0,
          duplicateOfAppealId: found.id === 'ap_2' ? 'ap_1' : undefined,
        },
      },
    };
  },
  '/api/appeals/suggest-reply': (body) => ({
    suggested:
      body.decision === 'overturned'
        ? 'After review we have reinstated your content. Thanks for appealing.'
        : body.decision === 'more_info'
          ? 'Could you tell us more about why you think this was a mistake?'
          : 'We reviewed your appeal and are upholding the original action.',
  }),
  '/api/appeals/decide': () => ({
    appeal: makeAppeal({ status: 'resolved' }),
    replySent: true,
  }),
  '/api/appeals/claim': (body) => ({
    appeal: makeAppeal({ id: body.appealId, assignedModId: 't2_modme', assignedModName: 'modme' }),
  }),
  '/api/appeals/unclaim': (body) => ({
    appeal: makeAppeal({ id: body.appealId, assignedModId: null, assignedModName: null }),
  }),
  '/api/appeals/erase': (body) => ({
    appeal: makeAppeal({ id: body.appealId, status: 'resolved', reason: '[erased]' }),
  }),
  '/api/analytics': (body) => ({
    analytics: { ...ANALYTICS, windowDays: body.windowDays || 30 },
  }),
};

/* ----------------------------------------------------------------------- */
/* Static + routing                                                        */
/* ----------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req, res) {
  let rel = req.url.split('?')[0];
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(CLIENT_DIR, path.normalize(rel));
  if (!file.startsWith(CLIENT_DIR)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const handler = api[url];
  if (handler) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(handler(body)));
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log('[mock-host] serving ' + CLIENT_DIR + ' on http://localhost:' + PORT);
});
