// `workbench workflows`: the same writes the editor screen makes (RUN-13), plus `edit`, which opens the file in
// $EDITOR and validates it on close — the file is the truth, and a hand edit is as legitimate as the screen's.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { WorkflowDetail, WorkflowListResponse } from '../../../shared/api/index.js';
import { workspacePaths } from '../../paths.js';
import { loadWorkflow } from '../../workspace/loader.js';
import { CliError, connect, findLiveRuntime } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

/** `EDITOR="code --wait"` and `EDITOR="C:\Program Files\x\editor.exe"` both have to work: split on spaces, honour quotes. */
export function editorCommand(configured: string | undefined, platform: NodeJS.Platform): { command: string; args: string[] } {
  const raw = configured?.trim() || (platform === 'win32' ? 'notepad' : 'vi');
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of raw) {
    if (quote) { if (ch === quote) quote = null; else current += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (current) { parts.push(current); current = ''; } continue; }
    current += ch;
  }
  if (current) parts.push(current);
  const [command, ...args] = parts;
  if (!command) throw new CliError('EDITOR is set but empty.');
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    throw new CliError(`EDITOR is "${command}", a batch file, which cannot be started safely on Windows. Point EDITOR at the program itself (the .exe).`);
  }
  return { command, args };
}

export function registerWorkflows(program: Command, bootstrap: Bootstrap): void {
  const workflows = program.command('workflows').description('the workflow files: list, create, edit in $EDITOR, delete');

  workflows
    .command('list')
    .description('every workflow in the workspace, and any file that did not load')
    .action(async (_o: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const res = await handle.request<WorkflowListResponse>('GET', '/workflows');
          if (wantsJson(cmd)) return outJson(res);
          for (const w of res.workflows) out(`${w.id.padEnd(24)} ${String(w.steps.length).padStart(2)} step${w.steps.length === 1 ? ' ' : 's'}  ${w.version.replace('sha256:', '').slice(0, 12)}  ${w.name}`);
          for (const e of res.errors) out(`${e.id.padEnd(24)} did not load: ${e.message}`);
          if (!res.workflows.length && !res.errors.length) out('No workflows. Create one with: workbench workflows new <id> --name "<name>"');
        } finally {
          await handle.close();
        }
      }),
    );

  workflows
    .command('show <id>')
    .description('the steps in the order they run, what each waits on, and what the validator would mention')
    .action(async (id: string, _o: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const w = await handle.request<WorkflowDetail>('GET', `/workflows/${encodeURIComponent(id)}`);
          if (wantsJson(cmd)) return outJson(w);
          out(`${w.name} (${w.id}) · ${w.file} · ${w.version.replace('sha256:', '').slice(0, 16)}`);
          if (w.description) out(w.description);
          for (const stepId of w.order) {
            const s = w.steps.find((x) => x.id === stepId);
            if (!s) continue;
            out(`  ${s.id.padEnd(16)} ${(s.kind === 'agent' ? s.agent ?? '' : s.kind).padEnd(16)} ${s.dependsOn.length ? `after ${s.dependsOn.join(', ')}` : ''}${s.review === 'blocking' ? '  waits for you' : ''}`);
          }
          for (const smell of w.smells) out(`  worth a look: ${smell.stepId} — ${smell.message}`);
          out(`${w.schedules} schedule${w.schedules === 1 ? '' : 's'} point${w.schedules === 1 ? 's' : ''} at it.`);
        } finally {
          await handle.close();
        }
      }),
    );

  workflows
    .command('new <id>')
    .description('write a new workflow file: one blank step, or a copy of an existing workflow (its schedule left behind)')
    .requiredOption('--name <name>', 'the name shown on the Workflows screen')
    .option('--copy-of <workflowId>', 'copy this workflow\'s steps and inputs')
    .action(async (id: string, opts: { name: string; copyOf?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const w = await handle.request<WorkflowDetail>('POST', '/workflows', { id, name: opts.name, ...(opts.copyOf ? { copyOf: opts.copyOf } : {}) });
          if (wantsJson(cmd)) return outJson(w);
          out(`Wrote ${w.file}. Edit it with: workbench workflows edit ${w.id}`);
        } finally {
          await handle.close();
        }
      }),
    );

  workflows
    .command('edit <id>')
    .description('open the workflow file in $VISUAL or $EDITOR; the file is validated when the editor closes')
    .action(async (id: string, _o: unknown, cmd: Command) =>
      guarded(async () => {
        const paths = workspacePaths(resolveWorkspace(cmd, bootstrap));
        const file = path.join(paths.workflows, `${id}.workflow.json`);
        if (!fs.existsSync(file)) throw new CliError(`There is no workflow called "${id}" (expected ${file}).`);
        const editor = editorCommand(bootstrap.editor, process.platform);
        const before = fs.readFileSync(file, 'utf8');
        const code = await new Promise<number>((resolve, reject) => {
          // The editor gets the same trimmed environment every other child does (SEC-07), plus a terminal.
          const child = spawn(editor.command, [...editor.args, file], { stdio: 'inherit', env: bootstrap.editorEnv });
          child.on('error', (e) => reject(new CliError(`Could not start "${editor.command}": ${e.message}. Set EDITOR to a program that exists.`)));
          child.on('exit', (status) => resolve(status ?? 1));
        });
        if (code !== 0) out(`${editor.command} exited with ${code}; checking the file anyway.`);
        const after = fs.readFileSync(file, 'utf8');
        if (after === before) { out('Unchanged.'); return; }
        // Validate exactly as the runtime loads it. The file stays as written either way: a person's edit is
        // not undone by a tool, it is reported.
        let version: string;
        try {
          version = loadWorkflow(file, id).version;
        } catch (e) {
          throw new CliError(`${(e as Error).message}\nThe file is saved as you left it, but the runtime will list it as broken until this is fixed. Run the command again to reopen it.`);
        }
        out(`Valid. ${path.basename(file)} is now ${version.replace('sha256:', '').slice(0, 16)}.`);
        const live = await findLiveRuntime(paths);
        if (!live) return;
        const res = await fetch(`http://127.0.0.1:${live.port}/api/v1/agents/reload`, { method: 'POST', headers: { Authorization: `Bearer ${live.token}` } });
        out(res.ok ? 'The running workbench has reloaded it.' : `The running workbench did not reload (${res.status}); press "Reload from disk" on the Workflows screen.`);
      }),
    );

  workflows
    .command('delete <id>')
    .description('remove the workflow file; refused while schedules point at it unless --with-schedules')
    .option('--with-schedules', 'also delete every schedule that points at this workflow')
    .action(async (id: string, opts: { withSchedules?: boolean }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const res = await handle.request<{ deleted: true; schedules: number }>('DELETE', `/workflows/${encodeURIComponent(id)}${opts.withSchedules ? '?deleteSchedules=true' : ''}`);
          if (wantsJson(cmd)) return outJson(res);
          out(`Deleted ${id}.workflow.json${res.schedules ? ` and ${res.schedules} schedule${res.schedules === 1 ? '' : 's'}` : ''}.`);
        } catch (e) {
          if (e instanceof CliError && e.message.includes('(conflict)')) throw new CliError(`${e.message}\nTo delete the schedules with it: workbench workflows delete ${id} --with-schedules`);
          throw e;
        } finally {
          await handle.close();
        }
      }),
    );
}
