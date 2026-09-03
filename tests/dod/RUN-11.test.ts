// RUN-11 Definition of done (spec/runs/RUN-11.md). Item 1 (a fresh workspace to a running pipeline) is @run-11
// in e2e; the Docker item is the smoke script in CI.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { CLI_DIST, runCli, startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';
import { PLUGIN_WARNING } from '../../src/runtime/plugins/loader.js';
import type { ImportResult, SettingsResponse, ToolsResponse } from '../../src/shared/api/index.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 11`, which builds first).');
});

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

/** A tool plugin, written the way someone else's would be: a manifest and a module with a default export. */
function writePlugin(ws: string, options: { name?: string; version?: string; scripts?: Record<string, string>; entry?: string } = {}): string {
  const name = options.name ?? 'weather';
  const dir = path.join(ws, 'plugins', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    schemaVersion: 1, name, version: options.version ?? '1.0.0', kind: 'tool',
    entry: options.entry ?? 'index.js',
    capabilities: ['reads a hard-coded forecast'],
    description: 'Answers what the weather is, badly.',
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), `
import { z } from 'zod';
export default {
  id: 'forecast',
  version: '1.0.0',
  description: 'The forecast, such as it is.',
  input: z.object({ where: z.string() }),
  output: z.object({ where: z.string(), forecast: z.string() }),
  tier: 'read',
  maxPermissions: { fs: { read: [], write: [] }, net: { allow: [], allowLocalAddresses: false, approvalExempt: [] }, tools: {}, approvalRequired: [] },
  execute: async (input) => ({ ok: true, output: { where: input.where, forecast: 'rain, on the third ring' } }),
};
`);
  if (options.scripts) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: options.version ?? '1.0.0', type: 'module', scripts: options.scripts }, null, 2));
  }
  return dir;
}

function trust(ws: string, key: string): void {
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  config['plugins'] = { trusted: [key] };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

describe('DoD 2: an exported agent imports as a request, not as a grant', () => {
  it('its permissions arrive requested, its grants do not come with it, and a bad schemaVersion is refused', async () => {
    const source = tempWorkspace('dod11-source');
    // The agent asks for a tool and is granted it here. Neither the ask nor the grant is a fact about anyone else.
    const agentFile = path.join(source, 'agents', 'weaver', 'agent.json');
    const definition = JSON.parse(fs.readFileSync(agentFile, 'utf8')) as Record<string, unknown>;
    definition['permissions'] = { tools: { 'artifact.write': 'allow', shell: 'allow' }, fs: { write: ['projects/'] } };
    fs.writeFileSync(agentFile, JSON.stringify(definition, null, 2));
    const configFile = path.join(source, 'config', 'workbench.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    config['grants'] = { weaver: { tools: { 'artifact.write': 'allow', shell: 'allow' } } };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    const exported = await runCli(['export', 'agent', 'weaver', '--json', '--workspace', source], { dist: true });
    expect(exported.code, exported.stderr).toBe(0);
    const bundle = JSON.parse(exported.stdout) as { schemaVersion: number; kind: string; payload: { definition: { id: string; permissions: { tools: Record<string, string> } } } };
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.kind).toBe('agent');
    expect(bundle.payload.definition.permissions.tools, 'what it asks for travels, because that is the author speaking').toEqual({ 'artifact.write': 'allow', shell: 'allow' });

    // Into a second workspace, which has never heard of it.
    const target = tempWorkspace('dod11-target');
    fs.rmSync(path.join(target, 'agents', 'weaver'), { recursive: true, force: true });
    const bundleFile = path.join(target, 'weaver.bundle.json');
    fs.writeFileSync(bundleFile, JSON.stringify(bundle));

    const imported = await runCli(['import', 'agent', bundleFile, '--json', '--workspace', target], { dist: true });
    expect(imported.code, imported.stderr).toBe(0);
    const result = JSON.parse(imported.stdout) as ImportResult;
    expect(result.id).toBe('weaver');
    expect(result.stripped.join(' '), 'it says what it did not carry over').toContain('kept as request');

    // The agent is there, asking; the grant matrix says no, because a downloaded file is not an authorization.
    const targetConfig = JSON.parse(fs.readFileSync(path.join(target, 'config', 'workbench.json'), 'utf8')) as { grants?: Record<string, unknown> };
    expect(targetConfig.grants?.['weaver'], 'nothing was granted by importing').toBeUndefined();

    const rt = await startRuntime(target, { providerOverride: 'mock', noScheduler: true });
    try {
      const tools = (await (await fetch(`${rt.baseUrl}/api/v1/tools`, { headers: headers(rt) })).json()) as ToolsResponse;
      const cell = tools.matrix.find((m) => m.agentId === 'weaver' && m.toolId === 'shell')!;
      expect(cell.requested, 'the ask survived').toBe(true);
      expect(cell.granted, 'the grant did not').toBe('unset');
      expect(cell.effective).toBe(false);
    } finally {
      await rt.stop();
    }

    // And a bundle from a version this workbench does not read is refused by name.
    const future = path.join(target, 'future.bundle.json');
    fs.writeFileSync(future, JSON.stringify({ ...bundle, schemaVersion: 99 }));
    const refused = await runCli(['import', 'agent', future, '--workspace', target], { dist: true });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain('schemaVersion 99');
    expect(refused.stderr + refused.stdout).toContain('newer version');
  }, 180_000);
});

describe('DoD 3: a plugin loads once a human has said it may', () => {
  it('is listed with its capabilities and the warning, and refuses to load until acknowledged', async () => {
    const ws = tempWorkspace('dod11-plugin');
    writePlugin(ws);

    // First: nobody has said yes, so it does not load — and says why in words a person can act on.
    const before = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const settings = (await (await fetch(`${before.baseUrl}/api/v1/settings`, { headers: headers(before) })).json()) as SettingsResponse;
      const plugin = settings.plugins.find((p) => p.name === 'weather')!;
      expect(plugin.loaded).toBe(false);
      expect(plugin.acknowledged).toBe(false);
      expect(plugin.capabilities).toEqual(['reads a hard-coded forecast']);
      expect(plugin.warning, 'the warning is the interface').toBe(PLUGIN_WARNING);
      expect(plugin.warning).toContain('runs with full access');
      expect(plugin.error).toContain('acknowledged');

      const tools = (await (await fetch(`${before.baseUrl}/api/v1/tools`, { headers: headers(before) })).json()) as ToolsResponse;
      expect(tools.tools.find((t) => t.id === 'weather.forecast'), 'nothing of it is in the catalogue').toBeUndefined();

      // Saying yes is a request, and it is recorded per version.
      const trusted = await fetch(`${before.baseUrl}/api/v1/plugins/trust`, {
        method: 'POST', headers: headers(before), body: JSON.stringify({ name: 'weather', version: '1.0.0' }),
      });
      expect(trusted.status).toBe(202);
    } finally {
      await before.stop();
    }

    // Second start: acknowledged, so it loads, and its tool is in the catalogue under the plugin's own name.
    const after = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const settings = (await (await fetch(`${after.baseUrl}/api/v1/settings`, { headers: headers(after) })).json()) as SettingsResponse;
      const plugin = settings.plugins.find((p) => p.name === 'weather')!;
      expect(plugin.loaded, plugin.error ?? 'no error given').toBe(true);
      expect(plugin.acknowledged).toBe(true);

      const tools = (await (await fetch(`${after.baseUrl}/api/v1/tools`, { headers: headers(after) })).json()) as ToolsResponse;
      const tool = tools.tools.find((t) => t.id === 'weather.forecast')!;
      expect(tool, 'the plugin name is in the tool id, so a grant is per plugin').toBeDefined();
      expect(tool.description).toContain('forecast');
      // Granted like anything else — which is to say, not yet.
      const cell = tools.matrix.find((m) => m.agentId === 'weaver' && m.toolId === 'weather.forecast')!;
      expect(cell.effective).toBe(false);
    } finally {
      await after.stop();
    }
  }, 180_000);

  it('a new version asks again, and a postinstall script is refused outright', async () => {
    const ws = tempWorkspace('dod11-plugin-2');
    writePlugin(ws, { version: '1.0.0' });
    trust(ws, 'weather@1.0.0');

    // The plugin is bumped without anyone looking at the new code.
    const dir = path.join(ws, 'plugins', 'weather');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as Record<string, unknown>;
    manifest['version'] = '1.1.0';
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const settings = (await (await fetch(`${rt.baseUrl}/api/v1/settings`, { headers: headers(rt) })).json()) as SettingsResponse;
      const plugin = settings.plugins.find((p) => p.name === 'weather')!;
      expect(plugin.acknowledged, 'a version nobody acknowledged is a version nobody acknowledged').toBe(false);
      expect(plugin.loaded).toBe(false);
    } finally {
      await rt.stop();
    }

    // And a plugin that would run code at install time never loads, acknowledged or not.
    const dangerous = tempWorkspace('dod11-plugin-3');
    writePlugin(dangerous, { name: 'sneaky', scripts: { postinstall: 'node -e "process.exit(0)"' } });
    trust(dangerous, 'sneaky@1.0.0');
    const rt2 = await startRuntime(dangerous, { providerOverride: 'mock', noScheduler: true });
    try {
      const settings = (await (await fetch(`${rt2.baseUrl}/api/v1/settings`, { headers: headers(rt2) })).json()) as SettingsResponse;
      const plugin = settings.plugins.find((p) => p.name === 'sneaky')!;
      expect(plugin.loaded).toBe(false);
      expect(plugin.error).toContain('postinstall');
      expect(plugin.error, 'and it says why that matters').toContain('before anyone can read the code');
    } finally {
      await rt2.stop();
    }
  }, 180_000);
});

describe('DoD 1: a fresh workspace runs the pipeline from the CLI, before any browser is involved', () => {
  it('init, then a workflow run, on the mock provider with no key and no network', async () => {
    const ws = path.join(tempWorkspace('dod11-fresh'), '..', `fresh-${Date.now()}`);
    const created = await runCli(['init', ws], { dist: true });
    expect(created.code, created.stderr).toBe(0);
    expect(fs.existsSync(path.join(ws, 'workspace.json'))).toBe(true);

    const inputs = path.join(ws, 'inputs.json');
    fs.writeFileSync(inputs, JSON.stringify({ premise: 'A dentist in an arcology finds a tooth that is not human.' }));
    const run = await runCli(['run', 'workflow', 'story-pipeline', '--inputs-file', inputs, '--provider', 'mock', '--json', '--workspace', ws], { dist: true });
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { state: string; runId: string };
    expect(result.state).toBe('completed');

    // And the trace is right there, which is the other half of "it works".
    const trace = await runCli(['trace', result.runId, '--workspace', ws], { dist: true });
    expect(trace.code).toBe(0);
    expect(trace.stdout).toContain('run-completed');

    // `doctor` on a fresh workspace says nothing is wrong.
    const doctor = await runCli(['doctor', '--json', '--workspace', ws], { dist: true });
    const report = JSON.parse(doctor.stdout) as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    expect(report.checks.filter((c) => !c.ok), JSON.stringify(report.checks)).toEqual([]);
    expect(report.ok).toBe(true);
  }, 240_000);
});

describe('the settings editor writes what it says it writes', () => {
  it('a credential goes into the 0600 file and never comes back out', async () => {
    const ws = tempWorkspace('dod11-creds');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const secret = 'AIzaNotARealKeyAtAll';
      const saved = await fetch(`${rt.baseUrl}/api/v1/settings/credentials`, {
        method: 'PUT', headers: headers(rt), body: JSON.stringify({ name: 'google', apiKey: secret }),
      });
      expect(saved.status).toBe(202);
      const body = (await saved.json()) as { providersConfigured: string[] };
      expect(body.providersConfigured, 'the names come back').toContain('google');
      expect(JSON.stringify(body), 'the value does not').not.toContain(secret);

      const file = path.join(ws, 'config', 'credentials.json');
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ google: { apiKey: secret } });
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);

      // Nothing the API serves can show it, including the settings route itself.
      const settings = await (await fetch(`${rt.baseUrl}/api/v1/settings`, { headers: headers(rt) })).text();
      expect(settings).not.toContain(secret);

      const removed = await fetch(`${rt.baseUrl}/api/v1/settings/credentials`, {
        method: 'PUT', headers: headers(rt), body: JSON.stringify({ name: 'google', apiKey: null }),
      });
      expect(removed.status).toBe(202);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('budgets and retention are editable; grants are not', async () => {
    const ws = tempWorkspace('dod11-settings');
    // The grants the example workspace ships with. A settings PUT must leave them exactly as they were.
    const grantsBefore = JSON.stringify((JSON.parse(fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8')) as { grants: unknown }).grants);

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const response = await fetch(`${rt.baseUrl}/api/v1/settings`, {
        method: 'PUT', headers: headers(rt),
        body: JSON.stringify({ budgets: { maxCostUsd: 5 }, retention: { scratchDays: 3 }, grants: { weaver: { tools: { shell: 'allow' } } } }),
      });
      expect(response.status).toBe(202);

      const config = JSON.parse(fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8')) as Record<string, Record<string, unknown>>;
      expect(config['budgets']!['maxCostUsd']).toBe(5);
      expect(config['retention']!['scratchDays']).toBe(3);
      expect(JSON.stringify(config['grants']), 'the grant matrix is not a setting; it is the Tools screen').toBe(grantsBefore);

      // The running runtime sees the change without a restart — and the keys nobody mentioned still have their
      // values, because the file holds what was set and the defaults fill in the rest (D-20).
      const settings = (await (await fetch(`${rt.baseUrl}/api/v1/settings`, { headers: headers(rt) })).json()) as SettingsResponse;
      expect(settings.budgets['maxCostUsd']).toBe(5);
      expect(settings.budgets['maxModelCalls'], 'the budgets it did not mention still apply').toBe(60);
      expect(settings.retention['backups'], 'and so does the rest of retention').toBeDefined();
    } finally {
      await rt.stop();
    }
  }, 120_000);
});
