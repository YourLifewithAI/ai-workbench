/// <reference lib="dom" />
// RUN-26 DoD 8 in the browser: the board is the front door — the orchestrator's band across the top with the
// conversation in it, every other agent as a card beneath — and the same board stacked on a phone.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, devices, type Page, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;
const ws = (): string => process.env['WB_E2E_WS']!;
const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' });

interface WorkItem { id: string; kind: string; state: string; title: string; answer: string | null }

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

async function startRun(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const started = await request.post(base() + '/api/v1/runs', { headers: auth(), data: { provider: 'mock', ...body } });
  expect(started.status(), await started.text()).toBe(202);
  const { runId } = (await started.json()) as { runId: string };
  await expect.poll(async () => ((await (await request.get(base() + `/api/v1/runs/${runId}`, { headers: auth() })).json()) as { state: string }).state, { timeout: 90_000 }).toMatch(/completed|failed/);
  return runId;
}

const work = async (request: APIRequestContext, state: 'open' | 'all'): Promise<WorkItem[]> =>
  ((await (await request.get(base() + `/api/v1/work?state=${state}`, { headers: auth() })).json()) as { items: WorkItem[] }).items;

/** Through the front door: the welcome path done, `/` is the board. */
async function land(page: Page): Promise<void> {
  await page.goto(base() + '/dashboard#token=' + token());
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('workbench.welcome-done', '1'));
  await page.goto(base() + '/#token=' + token());
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('orchestrator-band')).toBeVisible();
}

test('@run-26 the board is the front door, and two messages to the orchestrator are answered in its band, the reply streaming', async ({ page, request }) => {
  // Two scripted answers: one slow enough to be watched arriving, one that only makes sense as a follow-up.
  fs.writeFileSync(path.join(ws(), 'fixtures', 'aab-e2e-slowly.json'), JSON.stringify({
    match: { systemIncludes: 'Companion', lastUserIncludes: 'SLOWLY' },
    respond: { text: 'The weaver finished a scene and the researcher filed a briefing; nothing failed, nothing is waiting on you but the draft.', chunkDelayMs: 250 },
  }));
  fs.writeFileSync(path.join(ws(), 'fixtures', 'aab-e2e-second-one.json'), JSON.stringify({
    match: { systemIncludes: 'Companion', lastUserIncludes: 'and the second one?' },
    respond: { text: 'The briefing: three sources, one of them new, filed under research.' },
  }));
  expect((await request.post(base() + '/api/v1/agents/reload', { headers: auth() })).ok()).toBe(true);

  await land(page);
  const band = page.getByTestId('orchestrator-band');
  await expect(band.getByRole('heading', { name: 'Since you were last here' })).toBeVisible();
  await expect(band.getByTestId('since-lines')).toBeVisible();
  await expect(band.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The agents' })).toBeVisible();
  await expect(page.getByTestId('agent-cards')).toBeVisible();
  await expectNoA11yViolations(page, 'the board');

  // One message. The exchange is in the thread from the moment its run starts, the reply arriving in pieces —
  // a live region while it does — then settles with what it cost and where its trace is.
  const composer = page.getByLabel('Message to the orchestrator');
  await composer.fill('SLOWLY: what have the others been doing?');
  await page.getByRole('button', { name: 'Send' }).click();
  const thread = page.getByTestId('thread');
  const first = thread.locator('[data-testid^="exchange-"]').filter({ hasText: 'SLOWLY: what have the others been doing?' });
  await expect(first).toBeVisible({ timeout: 20_000 });
  await expect(composer, 'the composer waits for the answer').toBeDisabled();
  // Deltas are live, not replayed: the mock's first chunk is out before the follower has subscribed, so the
  // arriving text is read from its second chunk on; the reply as written is what the exchange settles on.
  const arriving = first.locator('[aria-live="polite"]');
  await expect(arriving).toBeVisible({ timeout: 20_000 });
  await expect(arriving).toContainText('the researcher filed a briefing', { timeout: 20_000 });
  await expect(first).toContainText('nothing is waiting on you but the draft.', { timeout: 30_000 });
  await expect(arriving, 'the reply is written; nothing is arriving').toBeHidden({ timeout: 20_000 });
  await expect(first).toContainText(/\$\d+\.\d{2}/);
  await expect(first.getByRole('link', { name: 'its trace' })).toBeVisible();
  await expect(composer, 'the composer is given back').toBeEnabled({ timeout: 20_000 });

  // A follow-up that only reads as one; the earlier turn went with it (DoD 4 proves what the model saw).
  await composer.fill('and the second one?');
  await composer.press('Control+Enter');
  await expect(thread.locator('[data-testid^="exchange-"]').filter({ hasText: 'The briefing: three sources' })).toBeVisible({ timeout: 30_000 });
  await expect(thread.locator('[data-testid^="exchange-"]')).toHaveCount(2);

  // Its trace is an ordinary run's page: the same heading, the same summary, the message as the run's input.
  await first.getByRole('link', { name: 'its trace' }).click();
  await expect(page.getByRole('heading', { name: /^Run / })).toBeVisible();
  expect(page.url()).toMatch(/\/runs\/[^/#]+/);
  await expect(page.getByText('SLOWLY: what have the others been doing?').first()).toBeAttached({ timeout: 20_000 });
});

test('@run-26 an agent\'s card says what it did lately, what it spent and how it was rated, and opens onto its last runs', async ({ page, request }) => {
  // Something for the weaver to have done lately: the specs before this one never run it.
  await startRun(request, { kind: 'agent', id: 'weaver', inputs: { input: 'A scene for the board: the lighthouse keeper counts ships.' }, project: 'anthology' });
  await land(page);
  const card = page.getByTestId('agent-card-weaver');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'The Weaver' })).toBeVisible();
  await expect(card.getByTestId('card-lately-weaver')).toContainText(/\d+ runs?|nothing this week/);
  await expect(card.getByTestId('card-spent-weaver').locator('dd')).toHaveText(/^\$\d+\.\d{2,4} today · \$\d+\.\d{2,4} this month$/);
  // Two numbers, each saying whose it is; none yet says so too.
  await expect(card.getByTestId('card-rated-weaver')).toContainText(/orchestrator( \d\.\d over \d+|: none yet) · you( \d\.\d over \d+|: none yet)/);

  await card.getByRole('button', { name: 'Details for The Weaver' }).click();
  const details = page.getByTestId('agent-details-weaver');
  await expect(details).toBeVisible();
  await expect(details.getByText('Last runs')).toBeVisible();
  await expect(details.getByRole('link', { name: 'trace' }).first()).toBeVisible({ timeout: 20_000 });
  await expectNoA11yViolations(page, 'the board with a card open');
  await card.getByRole('button', { name: 'Close for The Weaver' }).click();
  await expect(details).toBeHidden();

  // "Run it" is the run form that was always there.
  await card.getByRole('button', { name: 'Details for The Weaver' }).click();
  await details.getByRole('link', { name: 'Run it' }).click();
  await expect(page.getByRole('heading', { name: 'The Weaver' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Run/ })).toBeVisible();
});

test('@run-26 a decision the pulse left in the thread is answered there, and the card under Needs you goes with it', async ({ page, request }) => {
  await startRun(request, { kind: 'workflow', id: 'companion-pulse', inputs: {} });
  const decision = (await work(request, 'open')).find((i) => i.kind === 'decision')!;
  expect(decision, 'the pulse asked').toBeDefined();

  await land(page);
  const thread = page.getByTestId('thread');
  await expect(thread.locator('[data-testid^="pulse-"]').last()).toContainText('# The pulse');
  const inBand = page.getByTestId(`thread-decision-${decision.id}`);
  const onCard = page.getByTestId(`decision-${decision.id}`);
  await expect(inBand).toBeVisible({ timeout: 20_000 });
  await expect(onCard).toBeVisible();
  await expect(inBand).toContainText('Which piece does the weaver take next?');
  await expectNoA11yViolations(page, 'the board with a decision');

  await inBand.getByRole('button', { name: /The arcology, part two \(its lean\)/ }).click();
  await expect(inBand).toBeHidden({ timeout: 20_000 });
  await expect(onCard).toBeHidden({ timeout: 20_000 });
  await expect.poll(async () => (await work(request, 'all')).find((i) => i.id === decision.id)).toMatchObject({ state: 'decided', answer: 'a' });

  // Leave the ledger as it was found, so the specs after this one see the board they expect.
  for (const item of await work(request, 'open')) {
    expect((await request.put(base() + `/api/v1/work/${item.id}`, { headers: auth(), data: { state: 'done' } })).ok()).toBe(true);
  }
  expect(await work(request, 'open')).toEqual([]);
});

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 14'];
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

  test('@run-26 the same board, stacked: the band first with Needs you above the fold, then the cards in one column', async ({ page }) => {
    await land(page);
    const band = page.getByTestId('orchestrator-band');
    const needsYou = await band.getByRole('heading', { name: 'Needs you' }).boundingBox();
    expect(needsYou!.y, 'what needs you is above the fold').toBeLessThan(page.viewportSize()!.height);
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();

    const cards = page.getByTestId('agent-cards').locator('> li');
    expect(await cards.count()).toBeGreaterThan(1);
    const boxes = await Promise.all([0, 1].map(async (i) => (await cards.nth(i).boundingBox())!));
    expect(boxes[0]!.x, 'one column').toBe(boxes[1]!.x);
    expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'nothing sticks out sideways').toBeLessThanOrEqual(0);
    await expectNoA11yViolations(page, 'the board on a phone');
  });
});
