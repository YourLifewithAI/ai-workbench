// RUN-05 in the browser: the Dashboard reattaches to a run after the browser is closed, and Review decides a gate.
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

test('@run-05 the Dashboard reattaches to a run started before the browser was opened', async ({ browser, request }) => {
  // A run that takes long enough to still be going when a fresh browser arrives.
  const started = await request.post(`${base()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    data: { kind: 'workflow', id: 'story-pipeline', inputs: { premise: 'CANCEL-ME: a dentist finds a message in a tooth.' }, provider: 'mock' },
  });
  expect(started.ok()).toBe(true);
  const { runId } = (await started.json()) as { runId: string };

  const first = await browser.newContext();
  const page = await first.newPage();
  await page.goto(base() + '/dashboard#token=' + token());
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Running' })).toBeVisible();
  await expectNoA11yViolations(page, 'Dashboard');
  await first.close(); // the tab is gone; the run is not

  const second = await browser.newContext();
  const back = await second.newPage();
  await back.goto(base() + '/dashboard#token=' + token());
  await expect(back.getByRole('button', { name: `Cancel run ${runId}` })).toBeVisible({ timeout: 20_000 });

  // Following it by id replays what it did while nobody was watching.
  await back.goto(`${base()}/runs/${runId}#token=${token()}`);
  await expect(back.getByRole('heading', { name: /^Run / })).toBeVisible();
  await expect(back.getByText('step-started').first()).toBeVisible({ timeout: 20_000 });
  await back.getByRole('button', { name: 'Cancel run' }).click();
  await expect(back.getByText('cancelled').first()).toBeVisible({ timeout: 20_000 });
  await second.close();
});

test('@run-05 the Review queue rates an output and the rating sticks', async ({ page, request }) => {
  const started = await request.post(`${base()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    data: { kind: 'agent', id: 'architect', inputs: { input: 'A dentist finds a message in a tooth.' }, project: 'anthology', provider: 'mock' },
  });
  expect(started.ok()).toBe(true);
  const { runId } = (await started.json()) as { runId: string };
  // Other suites run the architect too, so the card is found by this run's id rather than by the agent's name.
  const mine = (p: Page) => p.locator('li').filter({ has: p.getByRole('link', { name: `run ${runId.slice(-8)}` }) }).first();

  await page.goto(base() + '/review#token=' + token());
  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();
  await expect(mine(page)).toBeVisible({ timeout: 20_000 });
  await expectNoA11yViolations(page, 'Review');

  await mine(page).getByRole('button', { name: '4 out of 5' }).click();
  await expect(mine(page).getByText(/Rated 4\/5/)).toBeVisible({ timeout: 20_000 });

  // Coming back later finds it still rated: a rating is a row, not a piece of screen state. (A plain reload
  // would land on the token screen — the token is held in memory and scrubbed from the address bar by design.)
  await page.goto(base() + '/review#token=' + token());
  await expect(mine(page)).toBeVisible({ timeout: 20_000 });
  await expect(mine(page).getByText(/Rated 4\/5/)).toBeVisible({ timeout: 20_000 });
});
