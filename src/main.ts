/**
 * Appeal-Desk — main entrypoint for Devvit 0.13.
 *
 * Devvit 0.13 split the old monolithic Blocks app into a thinner Devvit shell
 * (forms, menu, triggers, scheduler, settings) plus a web-view "post" served
 * by `@devvit/web/server`. This file is the Devvit shell side: it configures
 * platform capabilities and imports the side-effecting modules that register
 * their handlers with Devvit.
 *
 * What lives here vs. elsewhere:
 *   - This file: Devvit.configure() + side-effecting imports.
 *   - src/server/*.ts: the registrations (triggers, scheduler, settings,
 *     intake form, menu). All use the still-supported Devvit static methods
 *     (addTrigger, addSchedulerJob, addSettings, addMenuItem, createForm).
 *   - src/_legacy_blocks/: the Blocks-mode UI from the v0.0.3 submission,
 *     preserved as a reference. Excluded from tsc.
 *   - client/index.html + client/app.js: the web-view dashboard rendered as
 *     the custom post. Served by Reddit's CDN; `/api/*` calls hit
 *     src/server/main.ts (the http server).
 *   - src/server/main.ts: the http server. Run only on demand (when a web
 *     view needs to fetch data).
 */

import { Devvit } from '@devvit/public-api';

// Capabilities. Same set as on 0.11/0.12: Reddit API (moderator scope),
// Redis (storage), no external HTTP. Scheduler is enabled by registering
// jobs (see ./server/scheduler.ts) plus the `scheduler.tasks` block in
// devvit.json.
Devvit.configure({
  redditAPI: true,
  redis: true,
});

// Side-effecting registrations. Each import calls Devvit.addX(...) at module
// load time so the registrations land before the bundle is sealed.
import './server/menu.js';
import './server/triggers.js';
import './server/scheduler.js';
import './server/settings.js';
import './server/intake.js';

export default Devvit;
