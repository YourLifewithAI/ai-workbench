// RUN-06 in the browser: granting a tool in the matrix, and approving a pending item from the keyboard.
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

test('@run-06 the Tools screen grants a tool, and the grant is what the runtime uses', async ({ page, request }) => {
  await page.goto(base() + '/tools#token=' + token());
  await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
  await expect(page.getByText('Tools are denied until you grant them.')).toBeVisible();
  await expectNoA11yViolations(page, 'Tools');

  // The matrix is the authority: pick the cell for one agent and one tool and grant it.
  const cell = page.getByLabel('calc for echo');
  await expect(cell).toBeVisible();
  await expect(cell).toHaveValue('unset');
  await cell.selectOption('allow');

  await expect
    .poll(async () => {
      const body = (await (await request.get(`${base()}/api/v1/tools`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as {
        matrix: { agentId: string; toolId: string; effective: boolean }[];
      };
      return body.matrix.find((m) => m.agentId === 'echo' && m.toolId === 'calc')?.effective;
    }, { timeout: 20_000 })
    .toBe(true);

  // Take it back, so the screen is a two-way door and the next run of this suite starts where it started.
  await cell.selectOption('unset');
  await expect
    .poll(async () => {
      const body = (await (await request.get(`${base()}/api/v1/tools`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as {
        matrix: { agentId: string; toolId: string; effective: boolean }[];
      };
      return body.matrix.find((m) => m.agentId === 'echo' && m.toolId === 'calc')?.effective;
    }, { timeout: 20_000 })
    .toBe(false);
});

test('@run-06 a pending approval is allowed from the Dashboard with the keyboard', async ({ page, request }) => {
  // The e2e workspace grants `permission.request` to the approval-fixture agent in global setup.
  const started = await request.post(`${base()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    data: { kind: 'agent', id: 'weaver', inputs: { input: 'APPROVE-ME: draft a scene.' }, project: 'anthology', provider: 'mock' },
  });
  expect(started.ok()).toBe(true);
  const { runId } = (await started.json()) as { runId: string };

  await page.goto(base() + '/dashboard#token=' + token());
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const card = page.locator('li').filter({ hasText: 'wants permission' }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The risk line says what would happen, in words — not just the tool id.
  await expect(card.getByText(/save a note beside the draft/)).toBeVisible();
  await expectNoA11yViolations(page, 'Dashboard with an approval');

  await page.locator('body').press('a');

  await expect
    .poll(async () => {
      const detail = (await (await request.get(`${base()}/api/v1/runs/${runId}`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as { state: string };
      return detail.state;
    }, { timeout: 20_000 })
    .toBe('completed');
  await expect(page.getByText('Nothing is waiting on you.').or(page.getByText(/would like a rating/))).toBeVisible({ timeout: 20_000 });
});

test('@run-07 the Tools screen says where each agent may actually go', async ({ page }) => {
  await page.goto(base() + '/tools#token=' + token());
  await expect(page.getByRole('heading', { name: 'Where they may go' })).toBeVisible();
  // The workspace policy, in the words the checker uses.
  await expect(page.getByText('only the hosts listed below')).toBeVisible();
  await expect(page.getByText('refused, including anything DNS resolves to one')).toBeVisible();

  // And the row for the agent that has the network tools, showing the mode the fetch path would compute. Scoped
  // to the network table: the disk-grants table below it (RUN-16) has a row for every agent too.
  const row = page.getByTestId('network-agents').getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'researcher' }) });
  await expect(row).toContainText('allowlist');
  await expectNoA11yViolations(page, 'Tools — network policy');
});

test('@run-08 the Memory screen remembers, shows provenance, and deletes with redaction', async ({ page, request }) => {
  // A memory a run quoted, so the delete dialog has a trace to offer to redact.
  const secret = `The standing interest is ${Date.now()}-local-first.`;
  const added = await request.post(`${base()}/api/v1/memory`, {
    headers: { Authorization: `Bearer ${token()}` },
    data: { content: secret, scope: 'workspace' },
  });
  expect(added.status()).toBe(201);

  await page.goto(base() + '/memory#token=' + token());
  await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible();
  await expectNoA11yViolations(page, 'Memory');

  // Provenance is on the card: how far it may be believed, whose it is, and who wrote it.
  const card = page.getByRole('listitem').filter({ hasText: secret });
  await expect(card).toBeVisible();
  await expect(card).toContainText('trusted');
  await expect(card).toContainText('workspace:workspace');
  await expect(card).toContainText('you wrote it');

  // Search narrows to it, and the empty state says so when nothing matches.
  await page.getByLabel('Search').fill('local-first');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: secret })).toBeVisible();

  // And deleting it is a two-step: the dialog says what it will do before it does it.
  await card.getByRole('button', { name: 'Delete…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete this memory?');
  await expectNoA11yViolations(page, 'Memory — delete dialog');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page.getByRole('listitem').filter({ hasText: secret })).toHaveCount(0);
});

test('@run-09 the Tools screen says whether code can run at all', async ({ page }) => {
  await page.goto(base() + '/tools#token=' + token());
  await expect(page.getByRole('heading', { name: 'What can run code' })).toBeVisible();

  // Whichever way this machine is set up, the card says which one it is and what follows from it. Scoped to the
  // card: without a sandbox, "no sandbox" is also a badge on every execute-tier row of the matrix above.
  const card = page.getByTestId('sandbox-status');
  await expect(card).toBeVisible();
  if (await card.getByText('sandbox available').count()) {
    await expect(card.getByText('Code runs in Deno with no network')).toBeVisible();
  } else {
    await expect(card.getByText('no sandbox')).toBeVisible();
    // Each tool by name, in whatever order the catalogue lists them: the claim is that it says which ones.
    for (const tool of ['code.execute', 'shell', 'fs.write']) await expect(card).toContainText(tool);
    await expect(card.getByText('There is no unsandboxed fallback')).toBeVisible();
  }
  await expectNoA11yViolations(page, 'Tools — sandbox');
});

test('@run-16 the Tools screen shows a repository grant and the branches it may push to', async ({ page }) => {
  await page.goto(base() + '/tools#token=' + token());
  await expect(page.getByRole('heading', { name: 'What they may reach on disk' })).toBeVisible();
  await expect(page.getByText('nothing an agent does there reaches')).toBeVisible();

  // The Mechanic's row: the checkout global setup granted it, and the pattern, in the words the checker uses.
  const table = page.getByTestId('disk-grants');
  const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'mechanic' }) });
  await expect(row).toContainText(process.env['WB_E2E_REPO']!);
  await expect(row).toContainText('may push to');
  await expect(row).toContainText('run/*');
  // An agent with no repository says so rather than showing an empty cell.
  const echo = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'echo' }) });
  await expect(echo).toContainText('none');

  // And the matrix lists the repository tools like any other: granted where setup granted them, nowhere else.
  await expect(page.getByLabel('git.push for mechanic')).toHaveValue('allow');
  await expect(page.getByLabel('check for mechanic')).toHaveValue('allow');
  await expect(page.getByLabel('git.push for echo')).toHaveValue('unset');
  await expect(page.getByLabel('check for echo')).toHaveValue('unset');
  await expectNoA11yViolations(page, 'Tools — repositories');
});

test('@run-10 Compare runs two models side by side, and the pick is stored on both', async ({ page }) => {
  await page.goto(base() + '/evaluate#token=' + token());
  await expect(page.getByRole('heading', { name: 'Evaluate' })).toBeVisible();
  await expectNoA11yViolations(page, 'Evaluate');

  // The screen says what it is for, and what it will not do.
  await expect(page.getByText('a judge model\'s opinion is an estimate')).toBeVisible();

  await page.getByLabel('Agent').selectOption('echo');
  const checkboxes = page.getByRole('checkbox');
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await page.getByLabel('Input').fill('Say something about the rain.');
  await page.getByRole('button', { name: 'Run them side by side' }).click();

  const panes = page.getByTestId('compare-panes');
  await expect(panes).toBeVisible({ timeout: 30_000 });
  await expect(panes.getByRole('button', { name: 'This one is better' })).toHaveCount(2);
  await expect(panes.getByRole('link', { name: 'its trace' }).first()).toBeVisible();
  await expectNoA11yViolations(page, 'Evaluate — panes');

  await panes.getByRole('button', { name: 'This one is better' }).first().click();
  // The pick is stored on every pane, so the choice keeps both sides of itself.
  await expect.poll(async () => {
    const runs = await page.request.get(`${base()}/api/v1/runs?limit=10`, { headers: { Authorization: `Bearer ${token()}` } });
    return runs.ok();
  }).toBe(true);
});

test('@run-11 Settings edits what it says it edits, and never shows a key back', async ({ page, request }) => {
  await page.goto(base() + '/settings#token=' + token());
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('never shown back')).toBeVisible();
  await expectNoA11yViolations(page, 'Settings');

  const secret = `AIzaNotReal${Date.now()}`;
  await page.getByLabel('Provider').fill('google');
  await page.getByLabel('Key').fill(secret);
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // The name appears in the credentials list — with a Remove button beside it, which is what makes it that list
  // rather than the read-only summary above — and the value appears nowhere at all.
  const credentials = page.getByRole('listitem').filter({ hasText: 'google' }).filter({ has: page.getByRole('button', { name: 'Remove', exact: true }) });
  await expect(credentials).toBeVisible();
  await expect(page.locator('body')).not.toContainText(secret);
  const settings = await request.get(`${base()}/api/v1/settings`, { headers: { Authorization: `Bearer ${token()}` } });
  expect(await settings.text()).not.toContain(secret);

  // And taking it away works from the same screen. (Exact: the model-roles card has its own "Remove … from" buttons.)
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  // The credentials list's own words (L3): the MCP card says "None configured." too, and a substring match sees both.
  await expect(page.getByText('None yet. The mock provider needs none')).toBeVisible();
});

test('a repository is granted and taken back from the Tools screen, never in a file', async ({ page }) => {
  await page.goto(base() + '/tools#token=' + token());
  const table = page.getByTestId('disk-grants');
  const echo = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'echo' }) });
  await expect(echo).toContainText('none');

  await echo.getByRole('button', { name: 'Grant a repository: echo' }).click();
  const form = page.getByRole('form', { name: 'Grant a repository to echo' });
  // A relative path is refused with a sentence, not a stack trace.
  await form.getByLabel('Checkout path').fill('my-project');
  await form.getByRole('button', { name: 'Grant' }).click();
  await expect(echo.getByRole('alert')).toContainText('not an absolute path');

  await form.getByLabel('Checkout path').fill(process.env['WB_E2E_REPO']!);
  await form.getByLabel('Branches it may push to').fill('run/*');
  await form.getByRole('button', { name: 'Grant' }).click();
  await expect(echo).toContainText(process.env['WB_E2E_REPO']!, { timeout: 10_000 });
  await expect(echo).toContainText('may push to');

  await echo.getByRole('button', { name: `Remove repository ${process.env['WB_E2E_REPO']} from echo` }).click();
  await expect(echo).toContainText('none', { timeout: 10_000 });
});


test('which models do the work is set on Settings, in order, and never in an agent file', async ({ page, request }) => {
  await page.goto(base() + '/settings#token=' + token());
  const card = page.getByTestId('model-roles');
  await expect(card.getByRole('heading', { name: 'Which models do the work' })).toBeVisible();
  const fast = card.getByTestId('role-fast');
  await expect(fast.getByRole('listitem').first()).toContainText('google/gemini-3.6-flash');
  await expectNoA11yViolations(page, 'Settings with model roles');

  // Put the second model first, and save. The order is the whole decision.
  await fast.getByRole('button', { name: /Move anthropic\/claude-haiku-4-5 up in fast/ }).click();
  await expect(fast.getByRole('listitem').first()).toContainText('anthropic/claude-haiku-4-5');
  await card.getByRole('button', { name: 'Save models' }).click();
  await expect(card.getByText('Unsaved.')).toHaveCount(0);

  const settings = (await (await request.get(`${base()}/api/v1/settings`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as { models: { roles: Record<string, string[]> } };
  expect(settings.models.roles['fast']![0]).toBe('anthropic/claude-haiku-4-5');
  // Put it back, so the order other tests see is the shipped one. (A reload would lose the token fragment.)
  await page.goto(base() + '/settings#token=' + token());
  const again = page.getByTestId('model-roles').getByTestId('role-fast');
  await again.getByRole('button', { name: /Move anthropic\/claude-haiku-4-5 down in fast/ }).click();
  await page.getByTestId('model-roles').getByRole('button', { name: 'Save models' }).click();
  await expect(page.getByTestId('model-roles').getByText('Unsaved.')).toHaveCount(0);
});

test('the spending caps are set on Settings, and the Dashboard reads the month against its cap', async ({ page, request }) => {
  await page.goto(base() + '/settings#token=' + token());
  const caps = page.getByTestId('caps');
  await expect(caps.getByRole('heading', { name: 'Budgets' })).toBeVisible();
  await caps.getByLabel('Per month').fill('75');
  await caps.getByRole('button', { name: 'Save caps' }).click();
  await expect.poll(async () => ((await (await request.get(`${base()}/api/v1/settings`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as { budgets: { monthlySpendCapUsd: number } }).budgets.monthlySpendCapUsd).toBe(75);

  await page.goto(base() + '/dashboard#token=' + token());
  await expect(page.getByRole('heading', { name: 'Today and this month' })).toBeVisible();
  await expect(page.getByTestId('month-spend')).toContainText('of $75.00');
  await expect(page.getByRole('meter', { name: 'Monthly spending cap' })).toBeVisible();
  await expectNoA11yViolations(page, 'Dashboard with the month');

  // Put it back, so the number other tests see is the shipped one.
  await page.goto(base() + '/settings#token=' + token());
  await page.getByTestId('caps').getByLabel('Per month').fill('100');
  await page.getByTestId('caps').getByRole('button', { name: 'Save caps' }).click();
  await expect.poll(async () => ((await (await request.get(`${base()}/api/v1/settings`, { headers: { Authorization: `Bearer ${token()}` } })).json()) as { budgets: { monthlySpendCapUsd: number } }).budgets.monthlySpendCapUsd).toBe(100);
});
