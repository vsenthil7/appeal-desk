/**
 * Appeal-Desk dashboard — client web view.
 *
 * Vanilla JS / no framework. Talks to the server at /api/* (handled by
 * src/server/main.ts). Behaviour ported from the legacy Blocks shell:
 *
 *   - Queue tab: paginated list of open appeals with row pills (repeat
 *     count, ruleId, claimed-by, status), Load more, Refresh.
 *   - Detail screen: original context + user's appeal + decision history +
 *     triage flags (near-dup / paraphrase click to jump) + claim/unclaim
 *     row + 3 one-tap decision buttons (Uphold primary, Overturn / More
 *     info secondary) + Erase on resolved appeals.
 *   - Reply-confirm screen: opens after a decision tap; pre-filled with the
 *     suggested reply from the server; mod can edit, add internal note,
 *     then Send & record.
 *   - Analytics tab: 7d/30d toggle, headline tiles (Open / Resolved /
 *     Overturn rate / Median TTR), Top overturned rules or original
 *     reasons, by-action-type breakdown.
 */

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ */
/* Tiny DOM helper                                                     */
/* ------------------------------------------------------------------ */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'dataset' && typeof v === 'object') {
        for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = String(dv);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

/* ------------------------------------------------------------------ */
/* Formatters (mirror src/core/format.ts)                              */
/* ------------------------------------------------------------------ */

const statusLabels = {
  open: 'Open', in_review: 'In review',
  awaiting_user: 'Awaiting user', resolved: 'Resolved',
};
const statusPillClass = {
  open: 'pill-coral', in_review: 'pill-blue',
  awaiting_user: 'pill-violet', resolved: 'pill-green',
};
const actionLabels = {
  ban: 'Ban', removal: 'Post removal', comment_removal: 'Comment removal',
};
const decisionLabels = {
  upheld: 'Upheld', overturned: 'Overturned', more_info: 'Need more info',
};
const triageBadges = {
  likely_genuine:   { text: 'Likely genuine',  cls: 'pill-green'  },
  likely_duplicate: { text: 'Likely duplicate',cls: 'pill-amber'  },
  likely_abusive:   { text: 'Likely abusive',  cls: 'pill-coral'  },
};
const actionTypeLabels = {
  ban: 'Bans', removal: 'Post removals', comment_removal: 'Comment removals',
};

function relativeTime(then, now = Date.now()) {
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const hr = Math.floor(m / 60);
  if (hr < 24) return hr + 'h ago';
  const d = Math.floor(hr / 24);
  if (d < 30) return d + 'd ago';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + 'mo ago';
  return Math.floor(mo / 12) + 'y ago';
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 60_000) return Math.round(ms / 1000) + 's';
  if (ms < 60 * 60_000) return Math.round(ms / 60_000) + 'm';
  if (ms < 24 * 60 * 60_000) return Math.round(ms / (60 * 60_000)) + 'h';
  return Math.round(ms / (24 * 60 * 60_000)) + 'd';
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/* ------------------------------------------------------------------ */
/* API client                                                          */
/* ------------------------------------------------------------------ */

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    const code = json?.error?.code ?? 'HTTP_' + res.status;
    const msg = json?.error?.message ?? res.statusText;
    const err = new Error(msg);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  return json ?? {};
}

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */

const state = {
  tab: 'queue',              // 'queue' | 'analytics'
  screen: 'queue',           // 'queue' | 'detail' | 'reply'
  appeals: [],               // accumulated rows for the queue tab
  cursor: null,              // next-page cursor
  hasMore: true,
  openCount: 0,
  loading: false,
  detail: null,              // currently-opened Appeal object
  analyticsWindow: 30,
  analytics: null,
  me: null,                  // { subreddit, userId, username }
};

const $ = (id) => document.getElementById(id);
const root = $('root');
const slots = {
  queue: $('slot-queue'),
  analytics: $('slot-analytics'),
  detail: $('slot-detail'),
  reply: $('slot-reply'),
};

function showSlot(name) {
  for (const k of Object.keys(slots)) slots[k].hidden = (k !== name);
  root.dataset.screen = name;
}

function toast(message, kind) {
  const el = h('div', { class: 'toast ' + (kind === 'err' ? 'toast-err' : kind === 'ok' ? 'toast-ok' : '') }, message);
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ------------------------------------------------------------------ */
/* Queue tab                                                           */
/* ------------------------------------------------------------------ */

async function loadFirstPage() {
  state.loading = true;
  renderQueue();
  try {
    const data = await api('/api/appeals/list', { limit: PAGE_SIZE });
    state.appeals = data.items ?? [];
    state.cursor = data.nextCursor ?? null;
    state.hasMore = !!data.hasMore;
    state.openCount = data.openCount ?? 0;
  } catch (err) {
    toast('Could not load appeals: ' + err.message, 'err');
    state.appeals = []; state.cursor = null; state.hasMore = false; state.openCount = 0;
  }
  state.loading = false;
  renderHeader();
  renderQueue();
}

async function loadMore() {
  if (!state.cursor || state.loading) return;
  state.loading = true;
  renderQueue();
  try {
    const data = await api('/api/appeals/list', { limit: PAGE_SIZE, cursor: state.cursor });
    state.appeals = state.appeals.concat(data.items ?? []);
    state.cursor = data.nextCursor ?? null;
    state.hasMore = !!data.hasMore;
  } catch (err) {
    toast('Could not load more: ' + err.message, 'err');
  }
  state.loading = false;
  renderQueue();
}

function renderHeader() {
  const badge = $('badge-open');
  if (state.openCount > 0) {
    badge.textContent = state.openCount + ' open';
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function pill(text, cls, onClick) {
  return h('span', {
    class: 'pill ' + cls + (onClick ? ' pill-link' : ''),
    onclick: onClick,
  }, text);
}

function renderQueueRow(a) {
  const flags = [];
  if (a.repeatCount > 0) {
    flags.push(pill('↻ ' + a.repeatCount + ' prior', 'pill-amber'));
  }
  if (a.ruleId && a.ruleId !== 'unmapped') {
    flags.push(pill(a.ruleId, 'pill-gray'));
  }
  if (a.assignedModName) {
    flags.push(pill('claimed: u/' + a.assignedModName, 'pill-blue'));
  }
  return h('div', {
    class: 'row',
    onclick: () => openAppeal(a.id),
  },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-top' },
        h('span', { class: 'row-user' }, 'u/' + a.authorName),
        ...flags,
      ),
      h('div', { class: 'row-meta' },
        (actionLabels[a.actionType] ?? a.actionType) + ' · ' + relativeTime(a.createdAt),
      ),
    ),
    pill(statusLabels[a.status] ?? a.status, statusPillClass[a.status] ?? 'pill-gray'),
    h('span', { class: 'row-chev', 'aria-hidden': 'true' }, '›'),
  );
}

function renderQueue() {
  const slot = slots.queue;
  clear(slot);

  if (state.loading && state.appeals.length === 0) {
    slot.appendChild(h('p', { class: 'sub-line' }, 'Loading appeals…'));
    const list = h('div', { class: 'row-list' });
    for (let i = 0; i < 4; i++) {
      list.appendChild(h('div', { class: 'row skeleton' }, '·'));
    }
    slot.appendChild(list);
    return;
  }

  if (state.appeals.length === 0) {
    slot.appendChild(h('div', { class: 'empty-state' },
      'No appeals are waiting. New appeals will appear here the moment a user submits one.'));
    return;
  }

  slot.appendChild(h('p', { class: 'sub-line' },
    'Appeals for r/' + (state.me?.subreddit ?? '') + ' — most recent first'));

  const list = h('div', { class: 'row-list' });
  for (const a of state.appeals) list.appendChild(renderQueueRow(a));
  slot.appendChild(list);

  if (state.hasMore) {
    slot.appendChild(h('div', { class: 'load-more' },
      h('button', {
        class: 'btn btn-secondary',
        type: 'button',
        disabled: state.loading,
        onclick: loadMore,
      }, state.loading ? 'Loading…' : 'Load more'),
    ));
  }
}

/* ------------------------------------------------------------------ */
/* Detail screen                                                       */
/* ------------------------------------------------------------------ */

async function openAppeal(id) {
  showSlot('detail');
  clear(slots.detail);
  slots.detail.appendChild(h('p', { class: 'sub-line' }, 'Loading…'));
  try {
    const data = await api('/api/appeals/open', { appealId: id });
    state.detail = data.appeal;
    renderDetail();
  } catch (err) {
    toast('Could not load appeal: ' + err.message, 'err');
    backToQueue();
  }
}

function backToQueue() {
  state.detail = null;
  showSlot(state.tab === 'analytics' ? 'analytics' : 'queue');
}

function renderDetail() {
  const a = state.detail;
  if (!a) return;
  const slot = slots.detail;
  clear(slot);

  const dup = a.triage?.duplicateOfAppealId;
  const paraphrase = a.triage?.paraphraseOfAppealId;
  const ai = a.triage?.model;
  const resolved = a.status === 'resolved';
  const meId = state.me?.userId;
  const claimedByMe   = !!meId && !!a.assignedModId && a.assignedModId === meId;
  const claimedByOther = !!a.assignedModId && a.assignedModId !== meId;

  const flags = [];
  if (a.triage?.repeatCount > 0) {
    flags.push(pill(a.triage.repeatCount + ' prior appeal(s)', 'pill-amber'));
  }
  if (dup) {
    flags.push(pill('Near-duplicate of an earlier appeal →', 'pill-coral',
      () => openAppeal(dup)));
  }
  if (paraphrase) {
    flags.push(pill('Likely paraphrase of an earlier appeal →', 'pill-amber',
      () => openAppeal(paraphrase)));
  }
  if (a.ruleId && a.ruleId !== 'unmapped') {
    flags.push(pill(a.ruleId, 'pill-gray'));
  }
  if (a.assignedModName) {
    flags.push(pill('claimed: u/' + a.assignedModName, 'pill-blue'));
  }
  if (ai) {
    const b = triageBadges[ai.label];
    if (b) {
      flags.push(pill(b.text, b.cls));
      flags.push(h('span', { class: 'row-meta' },
        'AI hint · ' + Math.round((ai.confidence ?? 0) * 100) + '%'));
    }
  }

  // Header + back
  slot.appendChild(h('div', { class: 'detail' },
    h('div', { class: 'detail-hdr' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: backToQueue, title: 'Back' },
        h('span', { 'aria-hidden': 'true' }, '← Back')),
      h('h2', null, 'u/' + a.authorName),
      h('span', { style: 'flex:1' }),
      pill(statusLabels[a.status] ?? a.status, statusPillClass[a.status] ?? 'pill-gray'),
    ),
    h('p', { class: 'detail-meta' },
      (actionLabels[a.actionType] ?? a.actionType) + ' · submitted ' + relativeTime(a.createdAt)),

    flags.length > 0 ? h('div', { class: 'detail-flags' }, ...flags) : null,

    // Original context
    h('div', { class: 'card' },
      h('p', { class: 'label' }, 'Original removal reason'),
      h('div', { class: 'value' }, a.originalReason || '—'),
      h('p', { class: 'label' }, 'Original content'),
      h('div', { class: 'value' }, a.originalContent || '—'),
      a.permalink ? h('p', { class: 'label' }, 'Link') : null,
      a.permalink ? h('div', { class: 'value' }, a.permalink) : null,
    ),

    // User's appeal
    h('div', { class: 'card' },
      h('p', { class: 'label' }, "User's appeal"),
      h('div', { class: 'value' }, a.reason || '—'),
      h('p', { class: 'label' }, 'Acknowledged the rule?'),
      h('div', { class: 'value' }, a.acknowledged ? 'Yes' : 'No'),
      ai ? h('p', { class: 'label' }, 'AI rationale (hint only)') : null,
      ai ? h('div', { class: 'value' }, ai.rationale ?? '—') : null,
    ),

    // Decision history
    Array.isArray(a.decisions) && a.decisions.length > 0
      ? h('div', { class: 'card' },
          h('p', { class: 'label' }, 'Decision history'),
          ...a.decisions.map((d) => h('p', { class: 'history-line' },
            (decisionLabels[d.decision] ?? d.decision)
              + ' by u/' + d.modName
              + ' · ' + relativeTime(d.decidedAt)
              + (d.note ? ' — ' + d.note : ''),
          )))
      : null,

    // Claim row (above the decision row, like the legacy version)
    !resolved
      ? h('div', { class: 'claim-row' },
          claimedByMe
            ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: doUnclaim },
                'Release claim')
            : claimedByOther
              ? h('span', null, 'Currently claimed by u/' + a.assignedModName
                  + ' — pick a different appeal or wait.')
              : h('button', { class: 'btn btn-secondary', type: 'button', onclick: doClaim },
                  'Claim'),
        )
      : null,

    // Decision row (or resolved banner + erase)
    resolved
      ? h('div', null,
          h('div', { class: 'resolved-banner' }, 'This appeal is resolved.'),
          h('div', { class: 'btn-row', style: 'margin-top:8px;justify-content:center;' },
            h('button', { class: 'btn btn-danger', type: 'button', onclick: doErase },
              'Erase this appeal')),
        )
      : h('div', { class: 'decision-row' },
          h('button', { class: 'btn btn-primary', type: 'button',
            onclick: () => startDecision('upheld') }, 'Uphold'),
          h('button', { class: 'btn btn-secondary', type: 'button',
            onclick: () => startDecision('overturned') }, 'Overturn'),
          h('button', { class: 'btn btn-secondary', type: 'button',
            onclick: () => startDecision('more_info') }, 'Need more info'),
        ),
  ));
}

async function doClaim() {
  const id = state.detail?.id; if (!id) return;
  try {
    const r = await api('/api/appeals/claim', { appealId: id });
    state.detail = r.appeal;
    renderDetail();
    toast('Claimed.', 'ok');
  } catch (err) {
    toast('Could not claim: ' + err.message, 'err');
  }
}

async function doUnclaim() {
  const id = state.detail?.id; if (!id) return;
  try {
    const r = await api('/api/appeals/unclaim', { appealId: id });
    state.detail = r.appeal;
    renderDetail();
    toast('Released.', 'ok');
  } catch (err) {
    toast('Could not release: ' + err.message, 'err');
  }
}

async function doErase() {
  const id = state.detail?.id; if (!id) return;
  if (!confirm('Erase this appeal? Free text is scrubbed; an auditable tombstone is kept. Idempotent.')) return;
  try {
    await api('/api/appeals/erase', { appealId: id });
    toast('Appeal erased.', 'ok');
    backToQueue();
    await loadFirstPage();
  } catch (err) {
    toast('Erasure failed: ' + err.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* Reply-confirm screen                                                */
/* ------------------------------------------------------------------ */

async function startDecision(decision) {
  const id = state.detail?.id; if (!id) return;
  let suggested = '';
  try {
    const r = await api('/api/appeals/suggest-reply', { appealId: id, decision });
    suggested = r.suggested ?? '';
  } catch {
    // Non-fatal — fall through with an empty draft.
  }
  renderReply(decision, suggested);
}

function renderReply(decision, suggested) {
  const slot = slots.reply;
  clear(slot);
  showSlot('reply');

  const replyText = h('textarea', {
    name: 'reply', rows: 8, required: true,
  });
  replyText.value = suggested;

  const noteText = h('textarea', {
    name: 'note', rows: 3,
  });

  slot.appendChild(h('div', { class: 'reply' },
    h('h2', null, (decisionLabels[decision] ?? decision) + ' — confirm reply'),
    h('p', { class: 'hint' },
      'This reply will be sent to the user. Edit as needed. ' +
      'The decision is yours; AI only drafts wording.'),
    h('label', { for: 'reply' }, 'Reply to the user'),
    replyText,
    h('label', { for: 'note' }, 'Internal note (not sent to the user)'),
    noteText,
    h('div', { class: 'btn-row', style: 'margin-top:10px;' },
      h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => submitDecision(decision, replyText.value, noteText.value),
      }, 'Send & record'),
      h('button', {
        class: 'btn btn-secondary', type: 'button',
        onclick: () => { showSlot('detail'); renderDetail(); },
      }, 'Cancel'),
    ),
  ));
}

async function submitDecision(decision, reply, note) {
  const id = state.detail?.id; if (!id) return;
  try {
    const r = await api('/api/appeals/decide', {
      appealId: id, decision, finalReply: reply, note,
    });
    if (r.replySent === false && r.error) {
      toast('Decision recorded, but the reply could not be sent. Try again.', 'err');
    } else {
      toast('Appeal ' + (decisionLabels[decision] ?? decision).toLowerCase()
        + ' and reply sent.', 'ok');
    }
    state.detail = null;
    showSlot('queue');
    await loadFirstPage();
  } catch (err) {
    toast('Could not record the decision: ' + err.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* Analytics tab                                                       */
/* ------------------------------------------------------------------ */

async function loadAnalytics() {
  const slot = slots.analytics;
  clear(slot);
  slot.appendChild(h('p', { class: 'sub-line' }, 'Loading analytics…'));
  try {
    const r = await api('/api/analytics', { windowDays: state.analyticsWindow });
    state.analytics = r.analytics;
  } catch (err) {
    toast('Could not load analytics: ' + err.message, 'err');
    state.analytics = null;
  }
  renderAnalytics();
}

function renderAnalytics() {
  const slot = slots.analytics;
  clear(slot);
  const d = state.analytics;
  if (!d) {
    slot.appendChild(h('div', { class: 'empty-state' }, 'No analytics yet.'));
    return;
  }
  const overturnRate = d.resolvedInWindow > 0
    ? Math.round((d.overturnedInWindow / d.resolvedInWindow) * 100)
    : 0;
  const median = formatDuration(d.medianTimeToDecisionMs);

  slot.appendChild(h('div', { class: 'analytics' },
    // Window toggle
    h('div', { class: 'win-toggle' },
      h('span', null, 'Window:'),
      h('button', {
        class: 'btn ' + (state.analyticsWindow === 7 ? 'btn-primary' : 'btn-secondary'),
        type: 'button', onclick: () => { state.analyticsWindow = 7; loadAnalytics(); },
      }, '7d'),
      h('button', {
        class: 'btn ' + (state.analyticsWindow === 30 ? 'btn-primary' : 'btn-secondary'),
        type: 'button', onclick: () => { state.analyticsWindow = 30; loadAnalytics(); },
      }, '30d'),
    ),
    // Tiles
    h('div', { class: 'tiles' },
      h('div', { class: 'tile tile-coral' },
        h('div', { class: 'tile-label' }, 'Open'),
        h('div', { class: 'tile-value' }, String(d.openCount)),
      ),
      h('div', { class: 'tile tile-green' },
        h('div', { class: 'tile-label' }, 'Resolved (' + d.windowDays + 'd)'),
        h('div', { class: 'tile-value' }, String(d.resolvedInWindow)),
      ),
      h('div', { class: 'tile tile-violet' },
        h('div', { class: 'tile-label' }, 'Overturn rate'),
        h('div', { class: 'tile-value' }, overturnRate + '%'),
      ),
      h('div', { class: 'tile tile-blue' },
        h('div', { class: 'tile-label' }, 'Median TTR'),
        h('div', { class: 'tile-value' }, median),
      ),
    ),

    // Top overturned rules OR original reasons
    (d.topRulesOverturned?.length > 0)
      ? h('div', { class: 'card' },
          h('p', { class: 'label' }, 'Top overturned rules'),
          ...d.topRulesOverturned.map((r) =>
            h('p', { class: 'bullet' }, r.ruleId + ' — ' + r.count)),
        )
      : (d.topOriginalReasonsOverturned?.length > 0)
        ? h('div', { class: 'card' },
            h('p', { class: 'label' }, 'Top overturned reasons'),
            ...d.topOriginalReasonsOverturned.map((r) =>
              h('p', { class: 'bullet' }, truncate(r.reason, 60) + ' — ' + r.count)),
          )
        : h('div', { class: 'card' },
            h('p', { class: 'label' }, 'Top overturned rules'),
            h('p', { class: 'history-note', style: 'font-size:13px;margin:4px 0 0;' },
              'No overturns in the window — the rules are being applied consistently, '
              + 'or no decisions have landed yet.'),
          ),

    // By action type
    (d.byActionType?.length > 0)
      ? h('div', { class: 'card' },
          h('p', { class: 'label' }, 'Resolutions by action type'),
          ...d.byActionType.map((b) =>
            h('p', { class: 'bullet' },
              (actionTypeLabels[b.actionType] ?? b.actionType) + ' — ' + b.count)),
        )
      : null,
  ));
}

/* ------------------------------------------------------------------ */
/* Tabs / wiring                                                       */
/* ------------------------------------------------------------------ */

function setTab(name) {
  state.tab = name;
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('is-active', t.dataset.tab === name);
  }
  if (name === 'queue') {
    showSlot('queue');
  } else {
    showSlot('analytics');
    loadAnalytics();
  }
}

async function loadWhoami() {
  try {
    state.me = await api('/api/whoami', {});
  } catch {
    state.me = { subreddit: '', userId: 'unknown', username: 'unknown' };
  }
}

function wire() {
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  }
  $('btn-refresh').addEventListener('click', async () => {
    if (state.tab === 'analytics') await loadAnalytics();
    else await loadFirstPage();
  });
}

(async function init() {
  wire();
  await loadWhoami();
  await loadFirstPage();
})();
