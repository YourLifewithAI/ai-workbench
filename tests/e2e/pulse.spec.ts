/// <reference lib="dom" />
// RUN-24 DoD 8 in the browser: a decision the pulse put to the owner, answered on the Dashboard with one click;
// and the companion's spend against its caps and the loop it runs on, read off its card.
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;
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

test('@run-24 a decision the pulse put to you is answered on the Dashboard with one click', async ({ page, request }) => {
  // One pulse on the mock: it files a task and asks a question.
  await startRun(request, { kind: 'workflow', id: 'companion-pulse', inputs: {} });
  const decision = (await work(request, 'open')).find((i) => i.kind === 'decision')!;
  expect(decision, 'the pulse asked').toBeDefined();

  await page.goto(base() + '/dashboard#token=' + token());
  const card = page.getByTestId(`decision-${decision.id}`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Which piece does the weaver take next?');
  await expect(card.getByRole('button', { name: /The arcology, part two \(its lean\)/ })).toBeVisible();
  await expect(card.getByRole('button', { name: /The village, from the inside/ })).toBeVisible();
  await expect(page.getByTestId('work-list')).toContainText("Rate the weaver's last draft");
  await expectNoA11yViolations(page, 'Dashboard with a decision');

  // One click. The card goes; the answer is on the ledger for the next pulse to read.
  await card.getByRole('button', { name: /The arcology, part two/ }).click();
  await expect(card).toBeHidden({ timeout: 20_000 });
  await expect.poll(async () => (await work(request, 'all')).find((i) => i.id === decision.id)).toMatchObject({ state: 'decided', answer: 'a' });

  // Leave the ledger as it was found, so the specs after this one see the Dashboard they expect.
  for (const item of await work(request, 'open')) {
    expect((await request.put(base() + `/api/v1/work/${item.id}`, { headers: auth(), data: { state: 'done' } })).ok()).toBe(true);
  }
  expect(await work(request, 'open')).toEqual([]);
});

test('@run-24 the companion\'s card shows what it spent against its caps and the loop it runs on', async ({ page, request }) => {
  const schedules = ((await (await request.get(base() + '/api/v1/schedules', { headers: auth() })).json()) as { schedules: { id: string; workflowId: string; cron: string }[] }).schedules;
  const pulse = schedules.find((s) => s.workflowId === 'companion-pulse')!;
  expect(pulse, 'the pulse ships seeded').toBeDefined();
  const set = (enabled: boolean) => request.post(base() + `/api/v1/schedules?id=${pulse.id}`, { headers: auth(), data: { workflowId: 'companion-pulse', cron: pulse.cron, inputs: {}, project: 'companion', enabled, catchUp: 'none' } });
  expect((await set(true)).ok()).toBe(true);
  try {
    await page.goto(base() + '/agents#token=' + token());
    const heartbeat = page.getByTestId('heartbeat-companion');
    await expect(heartbeat).toBeVisible({ timeout: 20_000 });
    await expect(heartbeat).toContainText('The pulse, next');
    // Its runs and every run beneath them, against its own caps; an agent with no caps shows no "of".
    await expect(page.getByTestId('spend-companion').locator('dd')).toHaveText(/^\$\d+\.\d{2,4} today of \$5 · \$\d+\.\d{2,4} this month of \$40$/);
    await expect(page.getByTestId('spend-echo').locator('dd')).toHaveText(/^\$\d+\.\d{2,4} today · \$\d+\.\d{2,4} this month$/);
    await expect(page.getByTestId('heartbeat-echo')).toHaveCount(0);
    await expectNoA11yViolations(page, 'Agents with spend and a heartbeat');
  } finally {
    expect((await set(false)).ok(), 'the pulse is left off, as shipped').toBe(true);
  }
  // Off again on the server first; then a fresh document. Not a reload (the shell consumes the token from the
  // fragment, so a reload asks for it again) and not a goto of the same path (a fragment-only change keeps the
  // page and its cached agents list): another screen, then back.
  await expect.poll(async () => ((await (await request.get(base() + '/api/v1/schedules', { headers: auth() })).json()) as { schedules: { id: string; enabled: boolean }[] }).schedules.find((s) => s.id === pulse.id)?.enabled).toBe(false);
  await page.goto(base() + '/dashboard#token=' + token());
  await page.goto(base() + '/agents#token=' + token());
  await expect(page.getByTestId('heartbeat-companion')).toContainText('off — turn it on under Workflows', { timeout: 20_000 });
});
