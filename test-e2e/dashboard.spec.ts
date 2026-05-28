import { test, expect } from '@playwright/test';

/**
 * End-to-end test of the Appeal-Desk web-view dashboard.
 *
 * Loads the REAL client/ assets against a mock /api/* host (see
 * test-e2e/mock-host.cjs) and drives the full moderator flow in Chromium —
 * the same engine Reddit's web view uses. This is the automated version of
 * docs/SMOKE_TEST_v0.0.6.md steps 3-9.
 *
 * The headline assertion is "the dashboard is NOT a blank box" — the exact
 * symptom of the Devvit CLI 0.13.0 hosting bug. If our client code is sound
 * (it is), this passes; the blank box was purely Devvit's iframe host.
 */

test.describe('Appeal-Desk dashboard web view', () => {
  test('renders the shell (not a blank box)', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('.brand')).toHaveText('Appeal-Desk');
    await expect(page.locator('.tab[data-tab="queue"]')).toBeVisible();
    await expect(page.locator('.tab[data-tab="analytics"]')).toBeVisible();
    // The root must have real rendered height — i.e. not an empty 0px box.
    const box = await page.locator('#root').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(100);
  });

  test('loads the open-appeals queue from /api/appeals/list', async ({ page }) => {
    await page.goto('/index.html');
    const rows = page.locator('.row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('u/alice');
    await expect(rows.first()).toContainText('Comment removal');
    await expect(page.locator('#badge-open')).toContainText('3 open');
    const bobRow = rows.filter({ hasText: 'u/bob' });
    await expect(bobRow).toContainText('2 prior');
    await expect(bobRow).toContainText('rule-1');
    const carolRow = rows.filter({ hasText: 'u/carol' });
    await expect(carolRow).toContainText('claimed: u/modnine');
  });

  test('opens an appeal detail with original context + triage flags', async ({ page }) => {
    await page.goto('/index.html');
    await page.locator('.row', { hasText: 'u/bob' }).click();
    await expect(page.locator('.detail-hdr h2')).toHaveText('u/bob');
    // `.card` matches several; filter to the one with the original context.
    const contextCard = page.locator('.card', { hasText: 'Original removal reason' });
    await expect(contextCard).toContainText('Original removal reason');
    await expect(contextCard).toContainText('Rule 3: stay on topic');
    // bob's fixture has a near-duplicate flag -> a clickable pill.
    await expect(page.locator('.detail-flags')).toContainText('Near-duplicate');
    // Three decision buttons present.
    await expect(page.locator('.decision-row .btn')).toHaveCount(3);
    await expect(page.locator('.decision-row')).toContainText('Uphold');
    await expect(page.locator('.decision-row')).toContainText('Overturn');
    await expect(page.locator('.decision-row')).toContainText('Need more info');
  });

  test('claim / release flow toggles the button', async ({ page }) => {
    await page.goto('/index.html');
    await page.locator('.row', { hasText: 'u/alice' }).click();
    const claimBtn = page.locator('.claim-row .btn');
    await expect(claimBtn).toHaveText('Claim');
    await claimBtn.click();
    // After claim, the mock returns assignedModName=modme, so the button flips.
    await expect(page.locator('.claim-row .btn')).toHaveText('Release claim');
  });

  test('decision -> reply-confirm -> send flow', async ({ page }) => {
    await page.goto('/index.html');
    await page.locator('.row', { hasText: 'u/alice' }).click();
    // Tap Uphold.
    await page.locator('.decision-row .btn', { hasText: 'Uphold' }).click();
    // Reply-confirm screen with the suggested template pre-filled. The textarea
    // value is set programmatically (.value =), so assert on the VALUE, not the
    // text content.
    await expect(page.locator('.reply h2')).toContainText('Upheld');
    const replyBox = page.locator('textarea[name="reply"]');
    await expect(replyBox).toHaveValue(/upholding the original action/);
    // Edit + send.
    await replyBox.fill('Custom upheld reply for the test.');
    await page.locator('textarea[name="note"]').fill('internal test note');
    await page.locator('.reply .btn-primary', { hasText: 'Send & record' }).click();
    // A toast fires confirming the decision; queue reloads.
    await expect(page.locator('.toast')).toContainText('upheld');
  });

  test('analytics tab renders tiles + breakdowns', async ({ page }) => {
    await page.goto('/index.html');
    await page.locator('.tab[data-tab="analytics"]').click();
    await expect(page.locator('.tile')).toHaveCount(4);
    await expect(page.locator('.tile', { hasText: 'Open' })).toContainText('3');
    await expect(page.locator('.tile', { hasText: 'Overturn rate' })).toContainText('33%');
    await expect(page.locator('.card', { hasText: 'Top overturned rules' })).toContainText('rule-3');
    await expect(page.locator('.card', { hasText: 'by action type' })).toContainText('Comment removals');
    // 7d / 30d toggle works.
    await page.locator('.win-toggle .btn', { hasText: '7d' }).click();
    await expect(page.locator('.tile', { hasText: 'Resolved' })).toBeVisible();
  });

  test('no console errors during a full session', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/index.html');
    await page.locator('.row', { hasText: 'u/alice' }).click();
    await page.locator('.btn-ghost', { hasText: 'Back' }).click();
    await page.locator('.tab[data-tab="analytics"]').click();
    await page.waitForTimeout(300);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });
});
