/// <reference lib="dom" />
// RUN-19 in the browser (D-71): the village is the front door on a desktop; every building is a link named for
// its screen, in the shell's order, with its name and purpose in a box on hover and on focus and nothing
// written on the house; entering a building shows where you are and the way back; the town hall's board
// says what needs you. The phone half is `@run-19` in phone.spec.ts.
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;
const LABELS = ['Welcome', 'Dashboard', 'Library', 'Workflows', 'Agents', 'Runs', 'Review', 'Models', 'Memory', 'Tools', 'Evaluate', 'Settings'];

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

const ms = (duration: string): number => parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000);

test('@run-19 the village is the front door on a desktop once the welcome path is done', async ({ page }) => {
  await page.goto(base() + '/welcome#token=' + token());
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('workbench.welcome-done', '1'));
  await page.goto(base() + '/#token=' + token());
  await expect(page.getByRole('heading', { name: 'Village' })).toBeVisible();
  await expect(page.locator('[data-village="full"]')).toHaveCount(1);
});

test('@run-19 every building is a link named for its screen, in order, with its name in a box on hover and on focus and nothing on the house', async ({ page }) => {
  await page.goto(base() + '/village#token=' + token());
  await expect(page.getByRole('heading', { name: 'Village' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const links = nav.getByRole('link');
  await expect(links).toHaveText(LABELS);
  for (const [i, label] of LABELS.entries()) {
    const a = links.nth(i);
    await expect(a.locator('svg[aria-hidden="true"]'), `${label} is a picture`).toHaveCount(1);
    await expect(a.locator('a, button, [tabindex]'), `${label} holds nothing else focusable`).toHaveCount(0);
    await expect(a).toHaveAttribute('aria-describedby', /.+/);
    // The name is read out, never shown: the only text in the link is clipped to a pixel.
    expect(await a.locator('.sr-only').evaluate((el) => el.getBoundingClientRect().width), `${label}: no text on the house`).toBeLessThanOrEqual(1);
  }

  // Hover: the box names the building and says what it is for, and the link points at it.
  const library = nav.getByRole('link', { name: 'Library', exact: true });
  await library.hover();
  const tip = page.locator(`#${await library.getAttribute('aria-describedby')}`);
  await expect(tip).toBeVisible();
  await expect(tip).toHaveAttribute('role', 'tooltip');
  await expect(tip).toContainText('Library');
  await expect(tip).toContainText('Projects, documents, and every version your agents produce.');
  await expectNoA11yViolations(page, 'Village with a hover box');

  // Keyboard: from the theme select, twelve Tabs reach the twelve buildings in order, Settings last — the
  // budget the shell test's twenty-five presses rely on.
  await page.locator('select[aria-label="Theme"]').focus();
  const seen: string[] = [];
  for (let i = 0; i < 14 && seen.length < LABELS.length; i++) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? '');
    if (LABELS.includes(name) && !seen.includes(name)) seen.push(name);
  }
  expect(seen).toEqual(LABELS);

  // Focus shows the box; Esc hides it and focus stays where it was (WCAG 1.4.13).
  const settings = nav.getByRole('link', { name: 'Settings', exact: true });
  await expect(settings).toBeFocused();
  const settingsTip = page.locator(`#${await settings.getAttribute('aria-describedby')}`);
  await expect(settingsTip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settingsTip).toBeHidden();
  await expect(settings).toBeFocused();

  // The evening, and stillness. Reduced motion goes on *before* the theme changes, and not to make the test
  // easier: `transition-colors` animates `color` over 150ms, so for that moment the light blue is still
  // painted on the dark ground, and axe scanning inside the window reads a contrast failure that no one ever
  // sees settle. (It did exactly that on the macOS runner and nowhere else — the fade is shorter than axe's
  // own injection on a slower machine.) Under reduced motion `styles.css` collapses the transition to nothing,
  // so what is scanned is the colour at rest, which is the colour the rule is about.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.selectOption('select[aria-label="Theme"]', 'dark');
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  await expectNoA11yViolations(page, 'Village in the evening');
  await page.selectOption('select[aria-label="Theme"]', 'system');
  const durations = await page.evaluate(() => [document.querySelector('nav a'), document.querySelector('[role="tooltip"]')].map((el) => getComputedStyle(el!).transitionDuration));
  for (const d of durations) expect(ms(d), `transition-duration ${d}`).toBeLessThanOrEqual(0.01);
});

test('@run-19 entering a building shows where you are and the way back, and Back to the village returns focus to the village', async ({ page }) => {
  await page.goto(base() + '/village#token=' + token());
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  const band = page.locator('[data-interior]');
  await expect(band).toContainText('Library');
  await expect(band).toContainText('Projects, documents, and every version your agents produce.');
  // Inside, the street: the same twelve, in the same order, still links.
  await expect(page.locator('[data-village="compact"]')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link')).toHaveText(LABELS);
  await expectNoA11yViolations(page, 'Library inside its building');
  await band.getByRole('link', { name: 'Back to the village' }).click();
  await expect(page.getByRole('heading', { name: 'Village' })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('screen-title');
});

test('@run-19 the town hall board shows a running run with its budget and a Cancel, and takes it back', async ({ page, request }) => {
  await page.goto(base() + '/village#token=' + token());
  const board = page.getByTestId('town-hall');
  await expect(board).toContainText(/Nothing needs you|waiting for your|Running/);

  const slow = await request.post(`${base()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    data: { kind: 'workflow', id: 'story-pipeline', inputs: { premise: 'CANCEL-ME: a village finds a message in a well.' }, provider: 'mock' },
  });
  expect(slow.ok()).toBe(true);
  const { runId } = (await slow.json()) as { runId: string };

  const cancel = board.getByRole('button', { name: `Cancel run ${runId}` });
  await expect(cancel).toBeVisible({ timeout: 20_000 });
  // `has` takes a locator relative to each candidate, so it is rooted at the page here, not at the board.
  const card = board.locator('li').filter({ has: page.getByRole('button', { name: `Cancel run ${runId}` }) });
  await expect(card.getByRole('meter')).toHaveCount(1);
  await expectNoA11yViolations(page, 'Village with a run on the board');
  await cancel.click();
  await expect(cancel).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => {
    const res = await request.get(`${base()}/api/v1/runs/${runId}`, { headers: { Authorization: `Bearer ${token()}` } });
    return ((await res.json()) as { state: string }).state;
  }, { timeout: 20_000 }).toBe('cancelled');
});
