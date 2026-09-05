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
  // A failed run answers with its error, so a red CI log says what went wrong rather than only that it did.
  await expect.poll(async () => {
    const detail = (await (await request.get(`${base()}/api/v1/runs/${runId}`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as { state: string; error?: unknown };
    if (detail.state !== 'failed') return detail.state;
    const trace = await (await request.get(`${base()}/api/v1/runs/${runId}/trace.jsonl`, { headers: { Authorization: `Bearer ${token()}` } })).text();
    const failures = trace.split('\n').filter((l) => l.includes('"step-failed"') || l.includes('"run-failed"') || l.includes('"ok":false'));
    return `failed: ${JSON.stringify(detail.error)} ${failures.join(' ')}`;
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


test('@run-13 a workflow is edited as forms: the graph follows the draft, the save runs, the trace names the new agent', async ({ page, request }) => {
  await page.goto(base() + '/workflows#token=' + token());
  await page.getByRole('link', { name: 'New workflow' }).click();
  await expect(page.getByRole('heading', { name: 'New workflow' })).toBeVisible();
  await page.getByLabel('Name').fill('Edited in e2e');
  // The id follows the name until it is typed by hand.
  await expect(page.getByLabel('Id', { exact: true })).toHaveValue('edited-in-e2e');
  await page.getByLabel('A copy of an existing workflow').check();
  await page.getByLabel('Copy of', { exact: true }).selectOption('story-pipeline');
  await expectNoA11yViolations(page, 'New workflow');
  await page.getByRole('button', { name: 'Create workflow' }).click();

  await expect(page.getByRole('heading', { name: 'Edit Edited in e2e' })).toBeVisible();
  // The graph is drawn from the draft: three steps, as copied.
  await expect(page.getByText(/^final \(cutter\), after draft/)).toBeVisible();

  // Change a step's agent; the graph says so at once.
  const final = page.getByRole('group', { name: 'Step final' });
  await final.getByLabel('Agent', { exact: true }).selectOption('weaver');
  await final.getByLabel('Model', { exact: true }).fill('');
  await expect(page.getByText(/^final \(weaver\), after draft/)).toBeVisible();

  // Add a step. Until it refers to another step it is a root; the moment the reference is typed, the edge is there.
  await page.getByRole('button', { name: 'Add a step' }).click();
  const added = page.getByRole('group', { name: 'Step step-4' });
  await added.getByLabel('Step id').fill('check');
  const check = page.getByRole('group', { name: 'Step check' });
  await check.getByLabel('Agent', { exact: true }).selectOption('reviewer');
  await check.getByLabel('Input', { exact: true }).fill('Check these beats against the premise.');
  await expect(page.getByText(/^check \(reviewer\), with nothing before it/)).toBeVisible();
  await check.getByLabel('Input', { exact: true }).fill('Check these beats against the premise.\n\n{{steps.beats.output}}');
  await expect(page.getByText(/^check \(reviewer\), after beats/)).toBeVisible();
  await expect(page.getByRole('img', { name: /Workflow graph: 4 steps/ })).toBeVisible();
  await expectNoA11yViolations(page, 'Workflow editor');

  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByRole('heading', { name: 'Edited in e2e' })).toBeVisible();
  await expect(page.getByText('Saved. Runs started from now on use this version.')).toBeVisible();
  await expect(page.getByRole('img', { name: /Workflow graph: 4 steps/ })).toBeVisible();

  // Run it, and read the trace: the step runs on the agent it was just given.
  await page.getByLabel('Premise').fill('A dentist finds a message in a tooth.');
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByRole('heading', { name: /^Run / })).toBeVisible();
  for (const step of ['beats', 'draft', 'final', 'check']) {
    await expect(page.getByText(new RegExp(`^${step} \\(\\w+\\) is completed`))).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.getByText(/^final \(weaver\) is completed/)).toBeVisible();
  const runId = page.url().split('/runs/')[1]!.split(/[?#]/)[0]!;
  const trace = await request.get(base() + `/api/v1/runs/${runId}/trace.jsonl`, { headers: { Authorization: `Bearer ${token()}` } });
  const events = (await trace.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; stepId: string | null; payload: Record<string, unknown> });
  expect(events.find((e) => e.type === 'step-started' && e.stepId === 'final')?.payload['agentId']).toBe('weaver');
  expect(events.find((e) => e.type === 'step-started' && e.stepId === 'check')?.payload['agentId']).toBe('reviewer');
});

test('@run-13 deleting a workflow says how many schedules go with it', async ({ page, request }) => {
  const auth = { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' };
  const made = await request.post(base() + '/api/v1/workflows', { headers: auth, data: { id: 'delete-me-e2e', name: 'Delete me', copyOf: 'story-pipeline' } });
  expect(made.status()).toBe(201);
  const scheduled = await request.post(base() + '/api/v1/schedules', { headers: auth, data: { workflowId: 'delete-me-e2e', cron: '0 7 * * *', inputs: { premise: 'x' } } });
  expect(scheduled.status()).toBe(201);

  await page.goto(base() + '/workflows/delete-me-e2e#token=' + token());
  await expect(page.getByRole('heading', { name: 'Delete me' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete…' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('1 schedule points at it and will be deleted too.')).toBeVisible();
  await expectNoA11yViolations(page, 'Delete a workflow');
  await dialog.getByRole('button', { name: 'Delete workflow and 1 schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Delete me' })).toHaveCount(0);
  expect((await request.get(base() + '/api/v1/workflows/delete-me-e2e', { headers: auth })).status()).toBe(404);
});
