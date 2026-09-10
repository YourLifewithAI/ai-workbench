/// <reference lib="dom" />
// RUN-23 DoD 10 in the browser: the orchestrator's estimate beside the owner's rating, the owner's page chosen on
// Settings, and a run-written document approved as written in the Library.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;
const ws = (): string => process.env['WB_E2E_WS']!;
const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' });

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

async function startRun(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const started = await request.post(base() + '/api/v1/runs', { headers: auth(), data: { provider: 'mock', ...body } });
  expect(started.status(), await started.text()).toBe(202);
  const { runId } = (await started.json()) as { runId: string };
  await expect.poll(async () => ((await (await request.get(base() + `/api/v1/runs/${runId}`, { headers: auth() })).json()) as { state: string }).state, { timeout: 60_000 }).toMatch(/completed|failed/);
  return runId;
}

test('@run-23 the companion\'s estimate sits beside the owner\'s rating on the run\'s page and on Review', async ({ page, request }) => {
  // A run to rate, and a person's rating on it first.
  const rated = await startRun(request, { kind: 'agent', id: 'architect', inputs: { input: 'A dentist finds a message in a tooth.' }, project: 'anthology' });
  expect((await request.post(base() + '/api/v1/ratings', { headers: auth(), data: { runId: rated, stepId: 'main', value: 4, note: 'Good bones.' } })).status()).toBe(201);

  // The companion, scripted to rate that run. The fixture needs the run id, so it is written now and reloaded.
  fs.writeFileSync(path.join(ws(), 'fixtures', 'aab-e2e-rated.json'), JSON.stringify({ match: { systemIncludes: 'Companion', afterTool: 'runs.rate' }, respond: { text: 'Rated.' } }));
  fs.writeFileSync(path.join(ws(), 'fixtures', 'aac-e2e-rate-me.json'), JSON.stringify({
    match: { systemIncludes: 'Companion', lastUserIncludes: 'RATE-ME' },
    respond: { text: 'Rating.', toolCalls: [{ name: 'runs.rate', input: { run: rated, value: 3, why: 'Solid beats, thin ending.' } }] },
  }));
  expect((await request.post(base() + '/api/v1/agents/reload', { headers: auth() })).ok()).toBe(true);
  await startRun(request, { kind: 'agent', id: 'companion', inputs: { input: 'RATE-ME: rate the architect run.' }, project: 'companion' });

  await page.goto(`${base()}/runs/${rated}#token=${token()}`);
  const ratings = page.getByTestId('run-ratings');
  await expect(ratings).toBeVisible({ timeout: 20_000 });
  await expect(ratings).toContainText('You rated it 4/5 — Good bones.');
  await expect(ratings.getByTestId('estimate')).toContainText("orchestrator's estimate 3/5 — Solid beats, thin ending.");
  await expectNoA11yViolations(page, 'RunDetail with an estimate');

  await page.goto(base() + '/review#token=' + token());
  const card = page.locator('li').filter({ has: page.getByRole('link', { name: `run ${rated.slice(-8)}` }) }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(/Rated 4\/5/)).toBeVisible();
  await expect(card.getByTestId('estimate')).toContainText("orchestrator's estimate 3/5");
});

test('@run-23 the owner\'s page is chosen on Settings, and a project that does not exist is refused there', async ({ page, request }) => {
  await page.goto(base() + '/settings#token=' + token());
  const card = page.locator('section, div').filter({ has: page.getByRole('heading', { name: 'Your page' }) }).last();
  await expect(card.getByRole('heading', { name: 'Your page' })).toBeVisible();
  const input = page.getByLabel('Document, as project/path');
  await expect(input).toHaveValue('companion/about.md');
  await expectNoA11yViolations(page, 'Settings with the page');

  await input.fill('no-such-project/about.md');
  await page.getByRole('button', { name: 'Save your page' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'does not exist' })).toBeVisible();

  await input.fill('anthology/bible.md');
  await page.getByRole('button', { name: 'Save your page' }).click();
  await expect.poll(async () => ((await (await request.get(base() + '/api/v1/settings', { headers: auth() })).json()) as { owner: { profile: string | null } }).owner.profile).toBe('anthology/bible.md');

  // And back, so the other suites read the page they expect.
  await input.fill('companion/about.md');
  await page.getByRole('button', { name: 'Save your page' }).click();
  await expect.poll(async () => ((await (await request.get(base() + '/api/v1/settings', { headers: auth() })).json()) as { owner: { profile: string | null } }).owner.profile).toBe('companion/about.md');
});

test('@run-23 a document a run wrote says so in the Library, and one click approves it as written', async ({ page, request }) => {
  const runId = await startRun(request, { kind: 'workflow', id: 'companion-board', inputs: {} });
  const docs = ((await (await request.get(base() + '/api/v1/projects/companion/documents', { headers: auth() })).json()) as { documents: { id: string; path: string }[] }).documents;
  const board = docs.find((d) => d.path === `board/${runId}.md`);
  expect(board, 'the board was filed').toBeDefined();

  await page.goto(`${base()}/library/companion/${board!.id}#token=${token()}`);
  await expect(page.getByText('A run wrote this version.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('## The Weaver').first()).toBeVisible();
  await expectNoA11yViolations(page, 'a run-written document');
  await page.getByRole('button', { name: 'Approve as written' }).click();
  await expect(page.getByRole('button', { name: 'Approve as written' })).toHaveCount(0);
  await expect(page.getByText('A run wrote this version.')).toHaveCount(0);
  const detail = (await (await request.get(base() + `/api/v1/documents/${board!.id}`, { headers: auth() })).json()) as { content: string; version: { createdBy: string }; history: unknown[] };
  expect(detail.version.createdBy).toBe('human');
  expect(detail.history).toHaveLength(2);
  expect(detail.content).toContain('## The Weaver');
});
