/**
 * Bundle `src/server/main.ts` into a single CommonJS file at
 * `dist/server/main.js` for the Devvit 0.13 server runtime.
 *
 * Why this exists:
 *   - `devvit.json`'s `server.entry` points at a pre-bundled JS file. The
 *     Devvit CLI reads that file directly (no TS compile, no bundling); see
 *     `BundleModule.newServerBundle` in `@devvit/build-pack`.
 *   - The schema says: "Must be a self-contained JavaScript file except for
 *     standard Node.js API imports in CommonJS format." So everything from
 *     the source tree (core/, ai/, validators, etc.) must be inlined, but
 *     Node built-ins and the runtime-provided `@devvit/*` packages stay
 *     external (the host provides them).
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

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile,
    sourcemap: 'linked',
    // Devvit's host runtime provides these — they must stay as runtime imports
    // so the bundle is "self-contained except for standard Node.js APIs."
    // Anything beginning with `@devvit/` is a host-provided module under 0.13.
    external: [
      '@devvit/web',
      '@devvit/web/*',
      '@devvit/public-api',
      '@devvit/cache',
      '@devvit/media',
      '@devvit/notifications',
      '@devvit/payments',
      '@devvit/realtime',
      '@devvit/reddit',
      '@devvit/redis',
      '@devvit/scheduler',
      '@devvit/server',
      '@devvit/settings',
      '@devvit/shared',
      '@devvit/shared-types',
      '@devvit/protos',
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
