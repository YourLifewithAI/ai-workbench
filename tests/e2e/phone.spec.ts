// RUN-12 in the browser: the app at an iPhone viewport. Everything a person catches up on from their phone —
// approve, rate, read — with targets a thumb can actually hit.
import { test, expect, devices, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;

// The iPhone's shape, on the project's browser: `devices['iPhone 14']` also names WebKit, and taking that here
// would ignore the pinned Chromium the whole suite runs on.
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 14'];
test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

/** Every interactive thing on the screen has to be at least this tall for a thumb (ui.md §Phone). */
async function expectTouchTargets(page: Page, name: string): Promise<void> {
  const small = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('button, a[href], select, input[type="checkbox"]'))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue; // hidden
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      // Links inside a paragraph are text, not targets: they inherit the line box and are exempt by design.
      if (el.tagName === 'A' && el.parentElement && ['P', 'SPAN', 'LI', 'TD', 'DD'].includes(el.parentElement.tagName)) continue;
      // The skip link is 1px until it is focused, at which point it is full size. That is what it is for.
      if (el.classList.contains('skip-link')) continue;
      if (box.height < 44) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" is ${Math.round(box.height)}px`);
    }
    return out;
  });
  expect(small, `touch targets on ${name}`).toEqual([]);
}

test('@run-12 the app installs: the manifest, its icons, and the shell worker are all served', async ({ page, request }) => {
  await page.goto(base() + '/dashboard#token=' + token());
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // The link a browser follows to decide whether it can offer Add to Home Screen.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const manifest = await request.get(`${base()}/manifest.webmanifest`);
  expect(manifest.ok()).toBe(true);
  const parsed = (await manifest.json()) as { display: string; icons: { sizes: string }[]; start_url: string };
  expect(parsed.display).toBe('standalone');
  expect(parsed.icons.map((i) => i.sizes)).toContain('192x192');

  // The worker registers and takes the scope it claims.
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });
  expect(scope).toBe(`${base()}/`);
});

test('@run-12 an approval is decided from the phone, with thumb-sized targets', async ({ page, request }) => {
  const started = await request.post(`${base()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    data: { kind: 'agent', id: 'weaver', inputs: { input: 'APPROVE-ME: draft a scene for the phone.' }, project: 'anthology', provider: 'mock' },
  });
  expect(started.ok()).toBe(true);
  const { runId } = (await started.json()) as { runId: string };

  await page.goto(base() + '/dashboard#token=' + token());
  const card = page.locator('li').filter({ hasText: 'wants permission' }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // "Needs you" is above the fold: that is the whole point of the phone layout.
  const heading = await page.getByRole('heading', { name: 'Needs you' }).boundingBox();
  expect(heading!.y).toBeLessThan(page.viewportSize()!.height);

  await expectTouchTargets(page, 'Dashboard on a phone');
  await expectNoA11yViolations(page, 'Dashboard on a phone');

  await card.getByRole('button', { name: /Allow once/ }).tap();
  await expect
    .poll(async () => {
      const detail = (await (await request.get(`${base()}/api/v1/runs/${runId}`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as { state: string };
      return detail.state;
    }, { timeout: 20_000 })
    .toBe('completed');
});

test('@run-12 an output is rated from the phone, and the Runs list is readable without scrolling sideways', async ({ page, request }) => {
  const started = await request.post(`${base()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    data: { kind: 'agent', id: 'architect', inputs: { input: 'Plan a scene for the phone.' }, project: 'anthology', provider: 'mock' },
  });
  expect(started.ok()).toBe(true);
  const { runId } = (await started.json()) as { runId: string };

  await page.goto(base() + '/review#token=' + token());
  const mine = page.locator('li').filter({ has: page.getByRole('link', { name: `run ${runId.slice(-8)}` }) }).first();
  await expect(mine).toBeVisible({ timeout: 20_000 });
  await expectTouchTargets(page, 'Review on a phone');
  await expectNoA11yViolations(page, 'Review on a phone');

  await mine.getByRole('button', { name: '4 out of 5' }).tap();
  await expect(mine.getByText(/Rated 4\/5/)).toBeVisible({ timeout: 20_000 });

  // The Runs list is cards on a phone; a table would need a sideways scroll, which is how a phone layout fails.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Runs' }).tap();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'nothing sticks out sideways').toBeLessThanOrEqual(0);
  await expectNoA11yViolations(page, 'Runs on a phone');
});

test('@run-12 the Library reads on a phone', async ({ page }) => {
  await page.goto(base() + '/library#token=' + token());
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await page.getByRole('link', { name: /Anthology/i }).first().tap();
  await expect(page.getByRole('heading', { name: /Anthology/i })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoA11yViolations(page, 'Library on a phone');
});
