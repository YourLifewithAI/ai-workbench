// `workbench export` and `workbench import` for agents, workflows, memory and runs, plus `workbench plugins`.
// The point of these is that a workbench is shareable: what leaves is redacted and says so, and what arrives is
// a request rather than an authorization (D-34).
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { ImportResult, SettingsResponse } from '../../../shared/api/index.js';
import { CliError, connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

export function registerTransfer(exportCmd: Command, importCmd: Command, bootstrap: Bootstrap): void {
  for (const [name, route, argName] of [
    ['agent', '/export/agent', '<id>'],
    ['workflow', '/export/workflow', '<id>'],
  ] as const) {
    exportCmd
      .command(`${name} ${argName}`)
      .description(`write one ${name} out as a bundle; values are redacted and the bundle says which`)
      .option('--out <file>', 'write to a file rather than stdout')
      .action(async (id: string, opts: { out?: string }, cmd: Command) =>
        guarded(async () => {
          const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
          try {
            const file = await handle.request<{ redactions: string[] }>('GET', `${route}/${encodeURIComponent(id)}`);
            writeOrPrint(file, opts.out, cmd);
            if (!wantsJson(cmd) && file.redactions.length) out(`redacted: ${file.redactions.join(', ')}`);
          } finally {
            await handle.close();
          }
        }),
      );
  }

  exportCmd
    .command('memory')
    .description('write memory out as a bundle')
    .option('--scope <scope>', 'agent, project, workspace or user')
    .option('--out <file>')
    .action(async (opts: { scope?: string; out?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          writeOrPrint(await handle.request('GET', `/export/memory${opts.scope ? `?scope=${encodeURIComponent(opts.scope)}` : ''}`), opts.out, cmd);
        } finally {
          await handle.close();
        }
      }),
    );

  exportCmd
    .command('runs <ids>')
    .description('write one or more runs out with their traces, comma-separated')
    .option('--out <file>')
    .action(async (ids: string, opts: { out?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          writeOrPrint(await handle.request('GET', `/export/runs?ids=${encodeURIComponent(ids)}`), opts.out, cmd);
        } finally {
          await handle.close();
        }
      }),
    );

  for (const kind of ['agent', 'workflow', 'memory'] as const) {
    importCmd
      .command(`${kind} <file>`)
      .description(`read a ${kind} bundle in; what it asks for arrives as a request, not a grant`)
      .action(async (file: string, _opts: unknown, cmd: Command) =>
        guarded(async () => {
          const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
          try {
            const result = await handle.request<ImportResult>('POST', `/import/${kind}`, readJson(file));
            if (wantsJson(cmd)) return outJson(result);
            out(`imported ${result.kind} ${result.id}`);
            for (const line of result.stripped) out(`  not carried over: ${line}`);
            if (result.redactions.length) out(`  the export had redacted: ${result.redactions.join(', ')}`);
            out('Grant it what it needs in the Tools screen, or with `workbench tools grant`.');
          } finally {
            await handle.close();
          }
        }),
      );
  }
}

export function registerPlugins(program: Command, bootstrap: Bootstrap): void {
  const plugins = program.command('plugins').description('code that runs with the workbench\'s own authority');

  plugins
    .command('list')
    .description('what is in plugins/, whether it loaded, and whether anyone said it could')
    .action(async (_opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const settings = await handle.request<SettingsResponse>('GET', '/settings');
          if (wantsJson(cmd)) return outJson({ plugins: settings.plugins });
          if (!settings.plugins.length) return out('No plugins in this workspace.');
          for (const plugin of settings.plugins) {
            out(`${plugin.name}@${plugin.version}  ${plugin.kind}  ${plugin.loaded ? 'loaded' : 'not loaded'}`);
            if (plugin.capabilities.length) out(`  says it needs: ${plugin.capabilities.join(', ')}`);
            if (plugin.error) out(`  ${plugin.error}`);
          }
        } finally {
          await handle.close();
        }
      }),
    );

  plugins
    .command('trust <name>')
    .description('say yes to "this code runs with full access", for one version')
    .requiredOption('--version <version>', 'the exact version in its plugin.json')
    .action(async (name: string, opts: { version: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const settings = await handle.request<SettingsResponse>('GET', '/settings');
          const plugin = settings.plugins.find((p) => p.name === name);
          if (!wantsJson(cmd)) {
            out(plugin?.warning ?? 'This code runs with full access.');
            if (plugin?.capabilities.length) out(`It says it needs: ${plugin.capabilities.join(', ')}`);
            out('');
          }
          const result = await handle.request<{ trusted: string }>('POST', '/plugins/trust', { name, version: opts.version });
          if (wantsJson(cmd)) return outJson(result);
          out(`${result.trusted} is trusted. Restart the runtime to load it.`);
        } finally {
          await handle.close();
        }
      }),
    );
}

export function registerCredentials(program: Command, bootstrap: Bootstrap): void {
  const settings = program.command('settings').description('what this workspace is configured to do');

  settings
    .command('get')
    .description('the current settings; credentials are listed by name, never by value')
    .action(async (_opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const current = await handle.request<SettingsResponse>('GET', '/settings');
          if (wantsJson(cmd)) return outJson(current);
          out(`workspace   ${current.workspacePath} ("${current.workspaceName}")`);
          out(`network     ${current.networkMode}`);
          out(`sandbox     ${current.sandbox.deno ? 'available' : 'not installed — the execute tier is off'}`);
          out(`credentials ${current.providersConfigured.join(', ') || 'none'}`);
          out(`budgets     ${Object.entries(current.budgets).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        } finally {
          await handle.close();
        }
      }),
    );

  settings
    .command('set-credential <name>')
    .description('write a provider key into the 0600 file; it is never read back out')
    .option('--value <key>', 'the key; omit to read it from stdin, which keeps it out of your shell history')
    .option('--remove', 'delete this credential instead')
    .action(async (name: string, opts: { value?: string; remove?: boolean }, cmd: Command) =>
      guarded(async () => {
        const apiKey = opts.remove ? null : opts.value ?? (await readStdin());
        if (apiKey !== null && !apiKey.trim()) throw new CliError('No key was given. Pass --value, or pipe it in.');
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const result = await handle.request<{ providersConfigured: string[] }>('PUT', '/settings/credentials', {
            name, apiKey: apiKey === null ? null : apiKey.trim(),
          });
          if (wantsJson(cmd)) return outJson(result);
          out(`configured: ${result.providersConfigured.join(', ') || 'none'}`);
          out('Restart the runtime for it to be used.');
        } finally {
          await handle.close();
        }
      }),
    );
}

function writeOrPrint(value: unknown, file: string | undefined, cmd: Command): void {
  const text = JSON.stringify(value, null, 2);
  if (file) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), `${text}\n`);
    if (!wantsJson(cmd)) out(`wrote ${file}`);
    else outJson(value);
    return;
  }
  out(text);
}

function readJson(file: string): unknown {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) throw new CliError(`There is no file at "${file}".`);
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    throw new CliError(`"${file}" is not valid JSON: ${(e as Error).message}`);
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new CliError('Pass --value, or pipe the key in: `echo "$KEY" | workbench settings set-credential google`.');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
