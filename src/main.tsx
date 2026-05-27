/**
 * Appealdesk — main entrypoint.
 *
 * Configures the platform capabilities, registers the mod-only Appeals
 * Dashboard custom post, and imports the side-effecting modules (menu items,
 * triggers, scheduler, settings) so they register themselves with Devvit.
 */

import { Devvit } from '@devvit/public-api';
import { AppealsDashboardPost } from './components/AppealsDashboardPost.js';

// Capabilities. `redditAPI` for actions/modmail, `redis` for storage,
// `scheduler` for SLA nudges. No `http` — Appealdesk is fully on-platform.
Devvit.configure({
  redditAPI: true,
  redis: true,
});

// The dashboard custom post.
Devvit.addCustomPostType({
  name: 'Appeals Dashboard',
  height: 'tall',
  render: AppealsDashboardPost,
});

// Side-effecting registrations (import for side effects only).
import './server/menu.js';
import './server/triggers.js';
import './server/scheduler.js';
import './server/settings.js';

export default Devvit;
