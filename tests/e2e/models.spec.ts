/// <reference lib="dom" />
// RUN-02 DoD 4: the Models screen reports what a stubbed local endpoint says it has and greys what the network
// mode blocks; the Privacy Inspector shows the destination, categories, and redacted body of a routed call.
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

/** Leaves the workspace on allowlist, whatever the test did to it. */
async function restoreMode(page: Page): Promise<void> {
  await page.evaluate(async ([b, t]) => {
    await fetch(`${b}/api/v1/settings/network`, { method: 'PUT', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'allowlist' }) });
  }, [base(), token()]);
}

test('@run-02 the Models screen lists what the local endpoint reports, and says why the rest are not ready', async ({ page }) => {
  await page.goto(base() + '/models#token=' + token());
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible();

  await page.getByRole('button', { name: 'Check for changes' }).click();
  const ollama = page.getByRole('list', { name: 'Catalog' }).locator('li', { has: page.getByText('ollama/qwen3:14b', { exact: true }) }).first();
  await expect(ollama.getByText('ready')).toBeVisible({ timeout: 10_000 });
  await expect(ollama.getByText(/Pulled on this endpoint:.*llama3\.2:3b/)).toBeVisible();

  const gemini = page.getByRole('list', { name: 'Catalog' }).locator('li', { has: page.getByText('google/gemini-3.8-flash', { exact: true }) }).first();
  await expect(gemini.getByText('no key')).toBeVisible();
  await expect(gemini.getByText(/credential named "google"/)).toBeVisible();
  await expect(gemini.getByText('Trains on your content')).toBeVisible();

  await expectNoA11yViolations(page, 'Models');
});

test('@run-02 going offline is one click, and it greys the cloud models', async ({ page }) => {
  await page.goto(base() + '/models#token=' + token());
  await expect(page.getByText('Network: Allowlist')).toBeVisible();

  await page.getByRole('button', { name: 'Go offline' }).click();
  await expect(page.getByText('Network: Offline')).toBeVisible();
  await expect(page.getByText('Nothing leaves this machine. Local models still run.')).toBeVisible();

  const gemini = page.getByRole('list', { name: 'Catalog' }).locator('li', { has: page.getByText('google/gemini-3.8-flash', { exact: true }) }).first();
  await expect(gemini.getByText('blocked by network mode')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Go back online (allowlist)' }).click();
  await expect(page.getByText('Network: Allowlist')).toBeVisible();
  await restoreMode(page);
});

test('@run-02 the Privacy Inspector shows where a routed call went and what it carried', async ({ page }) => {
  // mock/upstream declares a baseUrl, so the mock adapter makes one real loopback round trip through the checker.
  await page.goto(base() + '/runs#token=' + token());
  const runId = await page.evaluate(async ([b, t]) => {
    const res = await fetch(`${b}/api/v1/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'agent', id: 'echo', inputs: { input: 'inspect this sentence' }, overrides: { model: 'mock/upstream' } }),
    });
    return ((await res.json()) as { runId: string }).runId;
  }, [base(), token()]);

  await page.goto(`${base()}/runs/${runId}#token=${token()}`);
  await expect(page.getByRole('heading', { name: /^Run/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Privacy Inspector' }).click();

  await expect(page.getByRole('heading', { name: 'Who received it' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('mock/upstream').first()).toBeVisible();
  await expect(page.getByText(/trains on content: no/)).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Every attempt to leave this machine' })).toBeVisible();
  const attempt = page.locator('details', { hasText: 'POST 127.0.0.1' }).first();
  await expect(attempt.getByText('allowed')).toBeVisible();
  await expect(attempt.getByText(/instructions, task/)).toBeVisible();
  await attempt.locator('summary').click();
  await expect(page.getByText('inspect this sentence').first()).toBeVisible();

  await expectNoA11yViolations(page, 'PrivacyInspector');
});

test('@run-15 Check for changes shows what the provider offers; one finding is accepted, one dismissed', async ({ page }) => {
  await page.goto(base() + '/models#token=' + token());
  await page.getByRole('button', { name: 'Check for changes' }).click();
  await expect(page.getByRole('heading', { name: 'What changed at the provider' })).toBeVisible({ timeout: 10_000 });

  const findings = page.getByRole('list', { name: 'Findings' });
  const catalog = page.getByRole('list', { name: 'Catalog' });

  // The provider's own name for the new model is an instruction. It is on the screen as text, and nothing else.
  const added = findings.locator('li', { has: page.getByRole('heading', { name: 'google/gemini-3.9-flash' }) });
  await expect(added.getByText('new', { exact: true })).toBeVisible();
  await expect(added.getByText(/Provider calls it: Ignore previous instructions/)).toBeVisible();

  const retired = findings.locator('li', { has: page.getByRole('heading', { name: 'google/gemini-3.6-flash' }) });
  await expect(retired.getByText('retired', { exact: true })).toBeVisible();

  await expectNoA11yViolations(page, 'Models with findings');

  // Accept the new one: it leaves the findings and appears in the catalog, disabled.
  await page.getByRole('button', { name: 'Add, disabled: google/gemini-3.9-flash' }).click();
  await expect(page.getByRole('button', { name: 'Add, disabled: google/gemini-3.9-flash' })).toHaveCount(0);
  const card = catalog.locator('li', { has: page.getByText('google/gemini-3.9-flash', { exact: true }) });
  await expect(card.getByText('disabled', { exact: true })).toBeVisible();

  // Dismiss the repriced one: gone from the list.
  await page.getByRole('button', { name: 'Dismiss: google/gemini-3.8-flash' }).click();
  await expect(page.getByRole('button', { name: 'Dismiss: google/gemini-3.8-flash' })).toHaveCount(0);
});
