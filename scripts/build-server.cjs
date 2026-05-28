/**
 * Bundle `src/server/main.ts` into a single CommonJS file at
 * `dist/server/main.js` for the Devvit 0.13 server runtime.
 *
 * Why this exists:
 *   - `devvit.json`'s `server.entry` points at a pre-bundled JS file. The
 *     Devvit CLI reads that file directly (no TS compile, no bundling); see
 *     `BundleModule.newServerBundle` in `@devvit/build-pack`.
 *   - The schema says: "Must be a self-contained JavaScript file except for
 *     standard Node.js API imports in CommonJS format."
 *
 * EXTERNAL POLICY (the key insight that took several iterations to find):
 *   The Devvit server runtime does NOT expose ANY `@devvit/*` package by
 *   name — not the barrels (`@devvit/web/server`, `@devvit/web`), not the
 *   sub-packages (`@devvit/server`, `@devvit/redis`, `@devvit/reddit`), and
 *   not even `@devvit/protos` sub-paths.
 *
 *   The bundle must be FULLY self-contained: every `@devvit/*` import gets
 *   inlined. Only Node built-ins are external.
 *
 * Run as: `node scripts/build-server.cjs` (also wired as `npm run build`).
 */

'use strict';

const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'server', 'main.ts');
const outdir = path.join(root, 'dist', 'server');
const outfile = path.join(outdir, 'main.js');

fs.mkdirSync(outdir, { recursive: true });

// Node built-in modules — these ARE available in the Devvit server runtime
// because it's a Node-shaped environment. Externalising them keeps the bundle
// smaller and matches the schema's "standard Node.js API imports" clause.
const nodeBuiltins = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'test', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
];

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile,
    sourcemap: 'linked',
    external: [
      'node:*',
      ...nodeBuiltins,
    ],
    logLevel: 'info',
    metafile: false,
    legalComments: 'none',
  })
  .then(() => {
    const stat = fs.statSync(outfile);
    const kb = (stat.size / 1024).toFixed(1);
    console.log(`[build-server] wrote ${path.relative(root, outfile)} (${kb} KB)`);
  })
  .catch((err) => {
    console.error('[build-server] failed:', err.message);
    process.exit(1);
  });
