// RUN-04 in the browser: the Workflows screen, the graph filling in step by step, and cancelling from Runs.
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

test('@run-04 the Workflows screen shows each workflow as a graph, and the run form comes from its inputs', async ({ page }) => {
  await page.goto(base() + '/workflows#token=' + token());
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Story pipeline' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ensemble draft' })).toBeVisible();
  // The graph is a picture, and the same thing in text for anyone not looking at it.
  await expect(page.getByRole('img', { name: /Workflow graph: 3 steps/ }).first()).toBeVisible();
  await expectNoA11yViolations(page, 'Workflows');

  await page.getByRole('link', { name: 'Story pipeline' }).click();
  await expect(page.getByRole('heading', { name: 'Story pipeline' })).toBeVisible();
  // The form is generated from the workflow's `inputs` schema, title and description included.
  await expect(page.getByLabel('Premise')).toBeVisible();
  await expect(page.getByText('One or two sentences. Who, where, and what is about to go wrong.')).toBeVisible();
  await expectNoA11yViolations(page, 'Workflow detail');
});

test('@run-04 running a workflow fills the graph in step by step', async ({ page }) => {
  await page.goto(base() + '/workflows/story-pipeline#token=' + token());
  await page.getByLabel('Premise').fill('A dentist in an arcology finds a message encoded in a tooth.');
  await page.getByRole('button', { name: 'Start run' }).click();

  await expect(page.getByRole('heading', { name: /^Run / })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Graph' })).toBeVisible();

  // Every step reaches `completed`, and the graph's text alternative is where that is readable.
  for (const step of ['beats', 'draft', 'final']) {
    await expect(page.getByText(new RegExp(`^${step} \\(\\w+\\) is completed`))).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.getByText('story-pipeline finished.')).toBeVisible({ timeout: 30_000 });
  await expectNoA11yViolations(page, 'Run detail with a graph');
});

test('@run-14 a workflow can be run with no provider key, and the form says so', async ({ page }) => {
  // The e2e runtime starts with --provider mock, which is exactly why this gap hid for thirteen runs: the
  // harness forced the mock globally, so nobody noticed the form never offered it. Assert the control itself.
  await page.goto(base() + '/workflows/story-pipeline#token=' + token());

  const mock = page.getByLabel('Use the mock provider (free, no key)');
  await expect(mock).toBeVisible();
  // No credential is configured in the test workspace, so the tick defaults on: a real run could only fail.
  await expect(mock).toBeChecked();

  // Unticking it warns rather than letting the run fail at its first model call.
  await mock.uncheck();
  await expect(page.getByText('No provider key is configured')).toBeVisible();
  await mock.check();

  await page.getByLabel('Premise').fill('A lighthouse keeper finds the light is answering someone.');
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByText('story-pipeline finished.')).toBeVisible({ timeout: 30_000 });
});

test('@run-04 a running workflow can be cancelled from the Runs screen', async ({ page, request }) => {
  // A fixture that streams slowly, so there is a run in flight to cancel rather than a race.
  const slow = await request.post(`${base()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    data: { kind: 'workflow', id: 'story-pipeline', inputs: { premise: 'CANCEL-ME: a dentist finds a message in a tooth.' }, provider: 'mock' },
  });
  expect(slow.ok()).toBe(true);
  const { runId } = (await slow.json()) as { runId: string };

  await page.goto(base() + '/runs#token=' + token());
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: runId }) });
  await expect(row.getByRole('button', { name: `Cancel run ${runId}` })).toBeVisible({ timeout: 20_000 });
  await expectNoA11yViolations(page, 'Runs with a budget bar and cancel');

  await row.getByRole('button', { name: `Cancel run ${runId}` }).click();
  await expect(row.getByText('cancelled')).toBeVisible({ timeout: 20_000 });
  // A cancelled run has nothing left to cancel.
  await expect(row.getByRole('button', { name: /Cancel run/ })).toHaveCount(0);
});

test('@run-17 the coding run: the form shows its inputs and budgets, and the parked review names the branch', async ({ page, request }) => {
  await page.goto(base() + '/workflows/coding-run#token=' + token());
  await expect(page.getByRole('heading', { name: 'Coding run' })).toBeVisible();
  // The two inputs, from the schema, and the budgets the workflow sets on its implement step.
  await expect(page.getByLabel('Brief')).toBeVisible();
  await expect(page.getByLabel('Repository')).toBeVisible();
  const budgets = page.getByTestId('run-budgets');
  await expect(budgets).toContainText('implement');
  await expect(budgets).toContainText('120 model calls · 400 tool calls · $10.00 · 90 min');
  await expect(page.getByText('waits for you').first()).toBeVisible();
  await expectNoA11yViolations(page, 'Coding run form');

  // Driven through the API against the fixture checkout global setup granted the Mechanic: the screen is
  // what is under test here, not the typing.
  const started = await request.post(`${base()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    data: { kind: 'workflow', id: 'coding-run', inputs: { brief: 'spec/runs/RUN-99.md', repo: process.env['WB_E2E_REPO'] }, provider: 'mock' },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const { runId } = (await started.json()) as { runId: string };
  await expect.poll(async () => {
    const detail = (await (await request.get(`${base()}/api/v1/runs/${runId}`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as { state: string };
    return detail.state;
  }, { timeout: 120_000 }).toBe('waiting_review');

  await page.goto(base() + '/review#token=' + token());
  const card = page.locator('li').filter({ has: page.getByRole('link', { name: `run ${runId.slice(-8)}` }) }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('holding the run still');
  await expect(card).toContainText('Branch: run/99-fixture');
  await expectNoA11yViolations(page, 'Review with a parked coding run');

  // Let it finish, so the workspace is not left holding a run for the next suite.
  await card.getByRole('button', { name: 'Continue the run' }).click();
  await expect.poll(async () => {
    const detail = (await (await request.get(`${base()}/api/v1/runs/${runId}`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as { state: string };
    return detail.state;
  }, { timeout: 60_000 }).toBe('completed');
});

