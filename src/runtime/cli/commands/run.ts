import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { CreateRunRequest, RunDetail, RunResult } from '../../../shared/api/index.js';
import { CliError, connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const POLL_MS = 150;

interface RunAgentOptions { input: string; project?: string; provider?: string; model?: string; detach?: boolean }

export function registerRun(program: Command, bootstrap: Bootstrap): void {
  const run = program.command('run').description('start a run');
  run
    .command('agent <id>')
    .description('run one agent on a task and wait for the result')
    .requiredOption('--input <text>', 'the task text (sent as { input })')
    .option('--project <slug>', 'project to run inside')
    .option('--provider <name>', '"mock" runs against the scripted mock provider')
    .option('--model <id>', 'override the agent\'s model policy with one catalog id')
    .option('--detach', 'return the run id immediately (needs a running `workbench start`)')
    .action(async (id: string, opts: RunAgentOptions, cmd: Command) =>
      guarded(async () => {
        if (opts.provider !== undefined && opts.provider !== 'mock') throw new CliError(`--provider accepts only "mock" (got "${opts.provider}")`);
        const workspaceDir = resolveWorkspace(cmd, bootstrap);
        const handle = await connect({ workspaceDir, bootstrap, requireLive: opts.detach === true });
        try {
          const body: CreateRunRequest = {
            kind: 'agent',
            id,
            inputs: { input: opts.input },
            ...(opts.project ? { project: opts.project } : {}),
            ...(opts.provider === 'mock' ? { provider: 'mock' as const } : {}),
            ...(opts.model ? { overrides: { model: opts.model } } : {}),
          };
          const { runId } = await handle.request<{ runId: string }>('POST', '/runs', body);
          if (opts.detach) {
            if (wantsJson(cmd)) outJson({ runId });
            else out(`${runId}  started (detached). Follow it with: workbench trace ${runId}`);
            return;
          }
          const detail = await waitForRun(handle.request.bind(handle), runId);
          const result: RunResult = { runId, state: detail.state, ...(detail.outputs ? { outputs: detail.outputs } : {}), costUsd: detail.spent.costUsd };
          if (wantsJson(cmd)) outJson(result);
          else {
            const output = detail.outputs?.['output'];
            if (typeof output === 'string') out(output);
            else if (output !== undefined) out(JSON.stringify(output, null, 2));
            out(`— run ${runId}: ${detail.state}, ${detail.spent.modelCalls} model call(s), $${detail.spent.costUsd.toFixed(4)}, ${detail.spent.wallClockMs} ms`);
          }
          if (detail.state !== 'completed') throw new CliError(describeFailure(detail));
        } finally {
          await handle.close();
        }
      }),
    );
}

async function waitForRun(request: <T>(method: string, apiPath: string) => Promise<T>, runId: string): Promise<RunDetail> {
  for (;;) {
    const detail = await request<RunDetail>('GET', `/runs/${runId}`);
    if (TERMINAL.has(detail.state)) return detail;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function describeFailure(detail: RunDetail): string {
  const e = detail.error as { reason?: string; error?: { message?: string } } | undefined;
  const message = e?.error?.message ?? (e?.reason ? `reason: ${e.reason}` : 'no details');
  return `run ${detail.id} ${detail.state}: ${message}`;
}
