import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { RunDetail, RunSummary } from '../../../shared/api/index.js';
import { connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

interface ListOptions { state?: string; kind?: string; project?: string; limit?: string }

export function registerRuns(program: Command, bootstrap: Bootstrap): void {
  const runs = program.command('runs').description('list and inspect runs');
  runs
    .command('list')
    .description('list runs, newest first')
    .option('--state <state>', 'filter by state')
    .option('--kind <kind>', 'filter by kind (agent|workflow)')
    .option('--project <slug>', 'filter by project')
    .option('--limit <n>', 'at most n runs', '50')
    .action(async (opts: ListOptions, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const q = new URLSearchParams();
          for (const [k, v] of Object.entries(opts)) if (typeof v === 'string' && v) q.set(k, v);
          const { runs: items } = await handle.request<{ runs: RunSummary[] }>('GET', `/runs?${q.toString()}`);
          if (wantsJson(cmd)) return outJson({ runs: items });
          if (!items.length) return out('No runs yet. Try: workbench run agent echo --input "hello" --provider mock');
          for (const r of items) out(`${r.id}  ${r.state.padEnd(16)} ${r.kind.padEnd(8)} ${(r.agentId ?? r.workflowId ?? '').padEnd(20)} ${r.startedAt}  $${r.spent.costUsd.toFixed(4)}`);
        } finally {
          await handle.close();
        }
      }),
    );
  runs
    .command('show <runId>')
    .description('show one run with its steps')
    .action(async (runId: string, _opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const detail = await handle.request<RunDetail>('GET', `/runs/${runId}`);
          if (wantsJson(cmd)) return outJson(detail);
          out(`run ${detail.id}  ${detail.kind} ${detail.agentId ?? detail.workflowId ?? ''}  ${detail.state}`);
          out(`started ${detail.startedAt}${detail.finishedAt ? `, finished ${detail.finishedAt}` : ''}`);
          out(`spent: ${detail.spent.modelCalls} model call(s), ${detail.spent.toolCalls} tool call(s), $${detail.spent.costUsd.toFixed(4)}, ${detail.spent.wallClockMs} ms`);
          for (const s of detail.steps) out(`  step ${s.stepId.padEnd(12)} ${s.kind.padEnd(8)} ${s.state.padEnd(10)} ${s.modelId ?? '-'}  $${s.costUsd.toFixed(4)}`);
          if (detail.outputs) out(`outputs: ${JSON.stringify(detail.outputs, null, 2)}`);
          if (detail.error !== undefined) out(`error: ${JSON.stringify(detail.error, null, 2)}`);
        } finally {
          await handle.close();
        }
      }),
    );
  runs
    .command('cancel <runId>')
    .description('stop a running run: in-flight model calls are aborted and nothing from them is committed')
    .action(async (runId: string, _opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap, requireLive: true });
        try {
          await handle.request('POST', `/runs/${runId}/cancel`);
          if (wantsJson(cmd)) return outJson({ runId, cancelled: true });
          out(`${runId}  cancelling`);
        } finally {
          await handle.close();
        }
      }),
    );
}
