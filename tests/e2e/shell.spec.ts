/// <reference lib="dom" />
// RUN-00 DoD 5: the shell loads with the token, lists the seeded run, opens its timeline; keyboard reaches every route;
// axe reports no WCAG 2.2 AA violations on Welcome, Runs, and Settings.
import { spawnSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

test('token handshake: the fragment is consumed and scrubbed; a reload without it asks for the token', async ({ page }) => {
  await page.goto(url());
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  await page.goto(base() + '/runs');
  await expect(page.getByRole('heading', { name: 'Runtime token required' })).toBeVisible();
  await expectNoA11yViolations(page, 'TokenRequired');
  await page.getByLabel('Or paste the token').fill(token());
  await page.getByRole('button', { name: 'Use this token' }).click();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
});

test('Runs lists the seeded run, updates live when the CLI starts another, and opens its timeline', async ({ page }) => {
  await page.goto(base() + '/runs#token=' + token());
  await expect(page.getByRole('table')).toBeVisible();
  const rowsBefore = await page.locator('tbody tr').count();
  expect(rowsBefore).toBeGreaterThanOrEqual(1);
  await expectNoA11yViolations(page, 'Runs');

  const seeded = process.env['WB_E2E_RUN_ID']!;
  await expect(page.getByRole('link', { name: seeded })).toBeVisible();

  const cli = spawnSync(process.execPath, [process.env['WB_E2E_CLI']!, 'run', 'agent', 'echo', '--input', 'from the CLI during e2e', '--json', '--workspace', process.env['WB_E2E_WS']!], { encoding: 'utf8' });
  expect(cli.status, cli.stderr).toBe(0);
  const started = (JSON.parse(cli.stdout) as { runId: string }).runId;
  // The workspace is shared with the other specs, so assert the new run arrives rather than a row count.
  await expect(page.getByRole('link', { name: started })).toBeVisible({ timeout: 10_000 });
  expect(await page.locator('tbody tr').count()).toBeGreaterThan(rowsBefore);

  await page.getByRole('link', { name: seeded }).click();
  await expect(page.getByRole('heading', { name: /^Run/ })).toBeVisible();
  await expect(page.getByTestId('event-type')).toHaveText(['run-started', 'step-started', 'model-started', 'model-completed', 'step-completed', 'run-completed']);
  // Since RUN-01 the compiled prompt lives under the step's model call rather than inside the raw event.
  await page.locator('details summary').filter({ hasText: 'mock/echo' }).first().click();
  await expect(page.getByRole('heading', { name: 'Compiled prompt' })).toBeVisible();
  await expect(page.getByText('seed run from e2e setup').first()).toBeVisible();
  await expectNoA11yViolations(page, 'RunDetail');
});

test('Welcome runs the example and reaches its trace; Settings is read-only and reachable', async ({ page }) => {
  await page.goto(base() + '/welcome#token=' + token());
  await expectNoA11yViolations(page, 'Welcome');
  await expect(page.getByRole('link', { name: 'The first hour on Windows' })).toHaveAttribute('href', /docs\/first-hour-windows\.md$/);
  await page.getByRole('button', { name: 'Try it with the mock' }).click();
  await page.getByRole('button', { name: 'Run the echo agent' }).click();
  await page.getByRole('button', { name: 'Open the trace' }).click();
  await expect(page.getByRole('heading', { name: /^Run/ })).toBeVisible();
  await expect(page.getByTestId('event-type')).toHaveCount(6);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Network mode')).toBeVisible();
  await expect(page.locator('dd', { hasText: 'allowlist' }).first()).toBeVisible();
  await expectNoA11yViolations(page, 'Settings');
});

test('keyboard-only navigation reaches every route; both themes and reduced motion apply', async ({ page }) => {
  await page.goto(base() + '/welcome#token=' + token());
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  const names = ['Welcome', 'Dashboard', 'Library', 'Workflows', 'Agents', 'Runs', 'Review', 'Models', 'Memory', 'Tools', 'Evaluate', 'Settings'];
  const seen = new Set<string>();
  for (let i = 0; i < 25 && seen.size < names.length; i++) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim());
    if (names.includes(label)) seen.add(label);
  }
  expect([...seen].sort()).toEqual([...names].sort());
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // Every navigation route renders something with a heading. Which ones are still placeholders changes every
  // run, so this asserts the invariant rather than a list that needs editing each time.
  for (const name of names) {
    await page.goto(base() + '/welcome#token=' + token());
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading').first()).toBeVisible();
    const placeholder = page.getByText(/Arrives in RUN-/);
    if (await placeholder.count()) await expect(placeholder.first()).toBeVisible();
  }
  await page.selectOption('select[aria-label="Theme"]', 'dark');
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  await page.selectOption('select[aria-label="Theme"]', 'light');
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const transition = await page.evaluate(() => getComputedStyle(document.querySelector('nav a')!).transitionDuration);
  const ms = transition.endsWith('ms') ? parseFloat(transition) : parseFloat(transition) * 1000;
  expect(ms, `transition-duration ${transition}`).toBeLessThanOrEqual(0.01);
});
