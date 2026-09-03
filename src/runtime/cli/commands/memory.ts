// `workbench memory` and `workbench import knowledge`: the two things RUN-08 adds that a person does by hand.
// Parity with the screen (ui.md §UX rules), including the redaction the delete dialog offers.
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { DeleteMemoryResponse, IngestKnowledgeResponse, MemoryItem, MemoryResponse, MemoryTracesResponse } from '../../../shared/api/index.js';
import { CliError, connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

export function registerMemory(program: Command, bootstrap: Bootstrap): void {
  const memory = program.command('memory').description('what agents remember between runs');

  memory
    .command('search [query]')
    .description('search memory, or list it')
    .option('--scope <scope>', 'agent, project, workspace or user')
    .action(async (query: string | undefined, opts: { scope?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const params = new URLSearchParams();
          if (query) params.set('q', query);
          if (opts.scope) params.set('scope', opts.scope);
          const { items } = await handle.request<MemoryResponse>('GET', `/memory${params.size ? `?${params}` : ''}`);
          if (wantsJson(cmd)) return outJson({ items });
          if (!items.length) return out('Nothing is remembered that matches.');
          for (const item of items) out(`${item.id}  ${item.trust.padEnd(9)} ${item.scope}:${item.ownerId}  ${item.content}`);
        } finally {
          await handle.close();
        }
      }),
    );

  memory
    .command('add <content>')
    .description('remember something yourself; what you write is trusted')
    .option('--scope <scope>', 'workspace (default), user, agent or project', 'workspace')
    .option('--owner <id>', 'the agent or project an agent- or project-scoped item belongs to')
    .option('--expires <iso>', 'a date after which it stops being retrieved')
    .action(async (content: string, opts: { scope: string; owner?: string; expires?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const item = await handle.request<MemoryItem>('POST', '/memory', {
            content, scope: opts.scope,
            ...(opts.owner ? { ownerId: opts.owner } : {}),
            ...(opts.expires ? { expiresAt: opts.expires } : {}),
          });
          if (wantsJson(cmd)) return outJson(item);
          out(`${item.id}  ${item.scope}:${item.ownerId}`);
        } finally {
          await handle.close();
        }
      }),
    );

  memory
    .command('delete <id>')
    .description('forget it; --redact-traces also takes its content out of the runs that quoted it')
    .option('--redact-traces', 'rewrite the traces that contained it, and record that you did')
    .action(async (id: string, opts: { redactTraces?: boolean }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          if (!opts.redactTraces && !wantsJson(cmd)) {
            const { runIds } = await handle.request<MemoryTracesResponse>('GET', `/memory/${encodeURIComponent(id)}/traces`);
            if (runIds.length) out(`${runIds.length} trace${runIds.length === 1 ? '' : 's'} quoted this item; --redact-traces would rewrite them.`);
          }
          const result = await handle.request<DeleteMemoryResponse>('DELETE', `/memory/${encodeURIComponent(id)}?redactTraces=${opts.redactTraces === true}`);
          if (wantsJson(cmd)) return outJson(result);
          out(result.redactedRuns.length ? `deleted, and redacted from ${result.redactedRuns.length} trace(s)` : 'deleted');
        } finally {
          await handle.close();
        }
      }),
    );
}

export function registerImportKnowledge(importCommand: Command, bootstrap: Bootstrap): void {
  importCommand
    .command('knowledge <file>')
    .description('read a file into a project as knowledge: md, txt, json, csv, html or pdf')
    .requiredOption('--project <slug>', 'the project it belongs to')
    .action(async (file: string, opts: { project: string }, cmd: Command) =>
      guarded(async () => {
        if (!fs.existsSync(file)) throw new CliError(`There is no file at "${file}".`);
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const result = await handle.requestBytes<IngestKnowledgeResponse>(
            'POST',
            `/projects/${encodeURIComponent(opts.project)}/knowledge?filename=${encodeURIComponent(path.basename(file))}`,
            fs.readFileSync(file),
          );
          if (wantsJson(cmd)) return outJson(result);
          out(`${result.path}  ${result.format}  ${result.characters.toLocaleString()} characters`);
        } finally {
          await handle.close();
        }
      }),
    );
}
