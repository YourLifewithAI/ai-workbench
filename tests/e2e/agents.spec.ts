/// <reference lib="dom" />
// RUN-01 DoD 4: run the Architect from the Agents screen, watch text stream, then read the run's summary and
// expand it to the compiled prompt, usage, and cost.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const url = (): string => process.env['WB_E2E_URL']!;
const base = (): string => url().split('/#')[0]!;
const token = (): string => url().split('#token=')[1]!;

async function expectNoA11yViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${name}`).toEqual([]);
}

test('@run-01 the Agents screen lists the workspace agents with their policy and version', async ({ page }) => {
  await page.goto(base() + '/agents#token=' + token());
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  for (const name of ['The Architect', 'The Weaver', 'The Cutter', 'Echo']) {
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText('google/gemini-3.8-flash').first()).toBeVisible();
  await expectNoA11yViolations(page, 'Agents');

  await page.getByRole('link', { name: 'The Architect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The Architect' })).toBeVisible();
  await expect(page.getByRole('group').filter({ hasText: '## task' })).toBeVisible();
  await expect(page.getByText('bible.md'), 'the world is a project document it injects, not a copy it carries').toBeVisible();
  await expectNoA11yViolations(page, 'AgentDetail');
});

/**
 * The displayed cost, computed from the shipped catalog rather than pasted in. A hardcoded figure here was
 * derived from gemini-2.5-pro's price and silently became wrong when that model was retired; it would have
 * gone wrong again on 2027-01-01 when Flash's introductory pricing lapses. The token counts come from the
 * fixture and are stable, so this stays an exact assertion without being a magic number.
 */
function expectedCost(modelId: string, input: number, output: number): string {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'defaults', 'models.json'), 'utf8'),
  ) as { models: { id: string; pricing: { effectiveFrom: string; inputPerM: number; outputPerM: number }[] }[] };
  const entry = catalog.models.find((m) => m.id === modelId)!;
  const now = new Date().toISOString();
  const price = entry.pricing.filter((r) => r.effectiveFrom <= now).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]!;
  return `$${((input * price.inputPerM + output * price.outputPerM) / 1_000_000).toFixed(4)}`;
}

test('@run-01 running an agent streams its text, then the run reads as a summary over a compiled prompt', async ({ page }) => {
  await page.goto(base() + '/agents/echo#token=' + token());
  await page.getByLabel('Task').fill('please be slow');
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  // The slow fixture paces its chunks, so the streaming block is visible before the output replaces it.
  await expect(page.getByRole('heading', { name: 'Streaming' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Output' })).toBeVisible({ timeout: 15_000 });

  await page.goto(base() + '/agents/architect#token=' + token());
  await page.getByLabel('Task').fill('A dentist finds binary in his patients tooth decay.');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Run/ })).toBeVisible();

  const summary = page.locator('section[aria-label="Summary"]').first();
  await expect(summary).toContainText('The Architect finished.', { timeout: 20_000 });
  await expect(summary.locator('li')).toHaveCount(2);
  await expect(summary).toContainText('1 model call');
  // 420 in / 260 out come from the fixture; the price comes from the catalog.
  await expect(summary).toContainText(expectedCost('google/gemini-3.8-flash', 420, 260));

  await page.locator('details summary').filter({ hasText: 'google/gemini-3.8-flash' }).first().click();
  await expect(page.getByRole('heading', { name: 'Compiled prompt' })).toBeVisible();
  await expect(page.getByText('## identity').first()).toBeVisible();
  await expect(page.getByText('Turn the premise into scene beats').first(), 'the instructions reached the prompt').toBeVisible();
  await expect(page.getByRole('heading', { name: 'Response' })).toBeVisible();
  await expectNoA11yViolations(page, 'RunDetail');
});

test('@run-01 a broken definition is reported on the screen, and reload picks up the fix', async ({ page }) => {
  const ws = process.env['WB_E2E_WS']!;
  const dir = path.join(ws, 'agents', 'broken-e2e');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), '{ "schemaVersion": 1, "id": "broken-e2e" }');

  await page.goto(base() + '/agents#token=' + token());
  await page.getByRole('button', { name: 'Reload from disk' }).click();
  await expect(page.getByText('broken-e2e did not load.')).toBeVisible();

  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    schemaVersion: 1, id: 'broken-e2e', name: 'Fixed By The Test', description: 'now valid',
    instructions: [{ name: 'task', text: 'Reply.' }], modelPolicy: { primary: 'mock/echo' },
  }));
  await page.getByRole('button', { name: 'Reload from disk' }).click();
  await expect(page.getByText('broken-e2e did not load.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Fixed By The Test', exact: true })).toBeVisible();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
