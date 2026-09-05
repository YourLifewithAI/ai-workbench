// `workbench models`: the catalog and what the providers say has changed (D-64). Every screen has a command.
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { CatalogFinding, ModelListResponse } from '../../../shared/api/index.js';
import { connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

function printFindings(res: ModelListResponse): void {
  for (const e of res.discovery?.errors ?? []) out(`${e.provider}: ${e.code} — ${e.message}`);
  if (!res.findings.length) {
    const checked = res.discovery?.checked ?? [];
    out(checked.length ? `Nothing has changed at ${checked.join(', ')}.` : 'No provider was asked: none of the adapters that can list has a credential.');
    return;
  }
  for (const f of res.findings) {
    const pins = f.pinnedBy.length ? `  pinned by ${f.pinnedBy.map((p) => (p.agentId ? `${p.agentId} (${p.role})` : `${p.workflowId} › ${p.stepId}`)).join(', ')}` : '';
    out(`${f.kind.padEnd(9)} ${f.id}${pins}`);
    out(`          ${f.detail}`);
  }
  out(`\n${res.findings.length} finding(s). Apply one with: workbench models accept <id>   Silence one with: workbench models dismiss <id>`);
}

export function registerModels(program: Command, bootstrap: Bootstrap): void {
  const models = program.command('models').description('the catalog, what can run now, and what the providers say has changed');

  models
    .command('list')
    .description('every catalog entry with whether it could run right now, and why not')
    .action(async (_o: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const res = await handle.request<ModelListResponse>('GET', '/models');
          if (wantsJson(cmd)) return outJson(res);
          for (const m of res.models) out(`${m.availability.padEnd(14)} ${m.id}${m.reason ? `  — ${m.reason}` : ''}`);
        } finally {
          await handle.close();
        }
      }),
    );

  models
    .command('refresh')
    .description('poll local endpoints and ask every provider you hold a key for what it offers; print the differences')
    .action(async (_o: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const res = await handle.request<ModelListResponse>('POST', '/models/refresh');
          if (wantsJson(cmd)) return outJson({ findings: res.findings, discovery: res.discovery ?? null });
          printFindings(res);
          if (res.discovery?.errors.length) process.exitCode = 1;
        } finally {
          await handle.close();
        }
      }),
    );

  for (const [verb, description] of [['accept', 'apply one finding to config/models.json, exactly as editing the file would'], ['dismiss', 'silence one finding until the provider\'s answer changes']] as const) {
    models
      .command(`${verb} <findingId>`)
      .description(description)
      .action(async (findingId: string, _o: unknown, cmd: Command) =>
        guarded(async () => {
          const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
          try {
            const res = await handle.request<ModelListResponse>('POST', `/models/findings/${encodeURIComponent(findingId)}/${verb}`);
            if (wantsJson(cmd)) return outJson({ ok: true, remaining: res.findings.length });
            out(verb === 'accept' ? `Applied ${findingId} to config/models.json.` : `Dismissed ${findingId}.`);
            const f: CatalogFinding | undefined = res.findings[0];
            out(res.findings.length ? `${res.findings.length} finding(s) remain${f ? `, next: ${f.id}` : ''}.` : 'No findings remain.');
          } finally {
            await handle.close();
          }
        }),
      );
  }
}
