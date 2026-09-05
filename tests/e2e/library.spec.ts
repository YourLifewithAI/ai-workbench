/// <reference lib="dom" />
// RUN-03 DoD 4: create, edit, diff, export — the Library from a browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('@run-03 the Library lists the shipped project and its documents', async ({ page }) => {
  await page.goto(base() + '/library#token=' + token());
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Anthology' })).toBeVisible();
  await expectNoA11yViolations(page, 'Library');

  await page.getByRole('link', { name: 'Anthology' }).click();
  await expect(page.getByRole('link', { name: 'bible.md' })).toBeVisible();
  await expectNoA11yViolations(page, 'ProjectDetail');
});

test('@run-03 creating a project, then running an agent into it, files the output', async ({ page }) => {
  await page.goto(base() + '/library#token=' + token());
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Slug').fill('e2e-project');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('link', { name: 'E2e Project' })).toBeVisible();

  await page.goto(base() + '/agents/architect#token=' + token());
  await page.getByLabel('Task').fill('A dentist finds binary in tooth decay.');
  await page.getByLabel('Target project').selectOption('e2e-project');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Run/ })).toBeVisible();
  await expect(page.locator('section[aria-label="Summary"]').first()).toContainText('finished', { timeout: 20_000 });

  await page.goto(base() + '/library/e2e-project#token=' + token());
  await expect(page.getByRole('link', { name: /^beats\// })).toBeVisible();
});

test('@run-03 a human edit becomes a second version, and the diff shows what changed', async ({ page }) => {
  await page.goto(base() + '/library/anthology#token=' + token());
  await page.getByRole('link', { name: 'bible.md' }).click();
  await expect(page.getByRole('heading', { name: 'bible.md' })).toBeVisible();
  await expect(page.getByText('overbearing grandmother')).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByLabel('Document content');
  await editor.fill((await editor.inputValue()) + '\n\n## Weather\n\nIt rains inside the Loop now.\n');
  await page.getByRole('button', { name: 'Save as a new version' }).click();

  await expect(page.getByText('human')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('It rains inside the Loop now.')).toBeVisible();

  await page.getByRole('button', { name: 'Compare with the previous version' }).first().click();
  await expect(page.getByRole('heading', { name: 'Diff' })).toBeVisible();
  await expect(page.getByText(/lines? added/)).toBeVisible();
  await expect(page.getByRole('table', { name: /difference/i }).getByText('It rains inside the Loop now.')).toBeVisible();
  await expectNoA11yViolations(page, 'DocumentView with diff');
});

test('@run-03 the exported folder is one a human can read', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-export-'));
  const result = spawnSync(process.execPath, [process.env['WB_E2E_CLI']!, 'export', 'project', 'anthology', '--out', out, '--json', '--workspace', process.env['WB_E2E_WS']!], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  const manifest = JSON.parse(result.stdout) as { documents: { path: string; redactions: string[] }[]; excluded: string[] };
  expect(manifest.documents.some((d) => d.path === 'bible.md')).toBe(true);
  expect(manifest.excluded).toContain('credentials');
  expect(fs.readFileSync(path.join(out, 'documents', 'bible.md'), 'utf8')).toContain('overbearing grandmother');
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('@run-18 a project\'s space is a form on its Library page, saved hash-pinned', async ({ page, request }) => {
  await page.goto(base() + '/library/anthology#token=' + token());
  const card = page.getByTestId('space');
  await expect(card.getByRole('heading', { name: 'Space' })).toBeVisible();
  await expect(card.getByLabel('Goals')).toHaveValue('');
  await expect(card.getByLabel('Goals').getByRole('option', { name: 'bible.md' })).toBeAttached();
  await expect(card.getByRole('checkbox', { name: 'weaver' })).toBeChecked();
  await expect(card.getByRole('checkbox', { name: 'researcher' })).not.toBeChecked();
  await expectNoA11yViolations(page, 'Library project with its space');

  // A change is a save, and the runtime reads it at once.
  await card.getByRole('checkbox', { name: 'researcher' }).check();
  await expect(card.getByText('Unsaved.')).toBeVisible();
  await card.getByRole('button', { name: 'Save space' }).click();
  await expect(card.getByRole('status')).toHaveText(/Saved/);
  const auth = { Authorization: `Bearer ${token()}` };
  const saved = (await (await request.get(base() + '/api/v1/projects/anthology/space', { headers: auth })).json()) as { space: { agents: string[] } };
  expect(saved.space.agents).toContain('researcher');

  // The file moved underneath (another save with the version this page loaded): the next save is refused, not applied.
  const current = (await (await request.get(base() + '/api/v1/projects/anthology/space', { headers: auth })).json()) as { version: string; space: Record<string, unknown> };
  await request.put(base() + '/api/v1/projects/anthology/space', { headers: { ...auth, 'Content-Type': 'application/json' }, data: { space: { ...current.space, agents: ['architect', 'weaver', 'cutter'] }, baseVersion: current.version } });
  await card.getByRole('checkbox', { name: 'judge' }).check();
  await card.getByRole('button', { name: 'Save space' }).click();
  await expect(card.getByRole('alert')).toContainText('changed since this form loaded it');
  await card.getByRole('button', { name: 'Load what is on disk' }).click();
  await expect(card.getByRole('checkbox', { name: 'researcher' })).not.toBeChecked();
  await expect(card.getByRole('checkbox', { name: 'judge' })).not.toBeChecked();
});
