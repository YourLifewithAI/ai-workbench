import fs from 'node:fs';
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { CreateRunRequest, RunDetail, RunResult } from '../../../shared/api/index.js';
import { CliError, connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const POLL_MS = 150;

interface RunAgentOptions { input: string; project?: string; provider?: string; model?: string; detach?: boolean }
interface RunWorkflowOptions { input?: string[]; inputsFile?: string; project?: string; provider?: string; detach?: boolean; maxModelCalls?: string; maxCostUsd?: string }

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

  run
    .command('workflow <id>')
    .description('run a workflow and wait for it to finish')
    .option('--input <key=value...>', 'one workflow input; repeatable. Values that parse as JSON are used as JSON.')
    .option('--inputs-file <path>', 'a JSON file holding the whole inputs object')
    .option('--project <slug>', 'project to run inside (else the workflow\'s defaultProject)')
    .option('--provider <name>', '"mock" runs against the scripted mock provider')
    .option('--max-model-calls <n>', 'narrow this run\'s model-call budget')
    .option('--max-cost-usd <n>', 'narrow this run\'s cost budget')
    .option('--detach', 'return the run id immediately (needs a running `workbench start`)')
    .action(async (id: string, opts: RunWorkflowOptions, cmd: Command) =>
      guarded(async () => {
        if (opts.provider !== undefined && opts.provider !== 'mock') throw new CliError(`--provider accepts only "mock" (got "${opts.provider}")`);
        const inputs = collectInputs(opts);
        const budget = collectBudget(opts);
        const workspaceDir = resolveWorkspace(cmd, bootstrap);
        const handle = await connect({ workspaceDir, bootstrap, requireLive: opts.detach === true });
        try {
          const body: CreateRunRequest = {
            kind: 'workflow',
            id,
            inputs,
            ...(opts.project ? { project: opts.project } : {}),
            ...(opts.provider === 'mock' ? { provider: 'mock' as const } : {}),
            ...(budget ? { overrides: { budget } } : {}),
          };
          const { runId } = await handle.request<{ runId: string }>('POST', '/runs', body);
          if (opts.detach) {
            if (wantsJson(cmd)) outJson({ runId });
            else out(`${runId}  started (detached). Follow it with: workbench trace ${runId}`);
            return;
          }
          const detail = await waitForRun(handle.request.bind(handle), runId);
          if (wantsJson(cmd)) {
            const result: RunResult = { runId, state: detail.state, ...(detail.outputs ? { outputs: detail.outputs } : {}), costUsd: detail.spent.costUsd };
            outJson({ ...result, steps: detail.steps });
          } else {
            for (const step of detail.steps) out(`  ${step.stepId.padEnd(14)} ${step.state.padEnd(10)} ${step.modelId ?? '-'}`);
            if (detail.outputs) out(JSON.stringify(detail.outputs, null, 2));
            out(`— run ${runId}: ${detail.state}, ${detail.spent.modelCalls} model call(s), $${detail.spent.costUsd.toFixed(4)}, ${detail.spent.wallClockMs} ms`);
          }
          if (detail.state !== 'completed') throw new CliError(describeFailure(detail));
        } finally {
          await handle.close();
        }
      }),
    );
}

/** `--inputs-file` is the base; each `--input k=value` overrides one key. A value that parses as JSON stays JSON. */
function collectInputs(opts: RunWorkflowOptions): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  if (opts.inputsFile) {
    let raw: string;
    try {
      raw = fs.readFileSync(opts.inputsFile, 'utf8');
    } catch (e) {
      throw new CliError(`cannot read --inputs-file ${opts.inputsFile}: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new CliError(`--inputs-file ${opts.inputsFile} is not valid JSON: ${(e as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CliError(`--inputs-file ${opts.inputsFile} must hold a JSON object of inputs`);
    Object.assign(inputs, parsed);
  }
  for (const pair of opts.input ?? []) {
    const at = pair.indexOf('=');
    if (at < 1) throw new CliError(`--input expects key=value (got "${pair}")`);
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    try {
      inputs[key] = JSON.parse(value);
    } catch {
      inputs[key] = value; // a bare string is the common case and should not need quoting
    }
  }
  return inputs;
}

function collectBudget(opts: RunWorkflowOptions): Record<string, number> | undefined {
  const budget: Record<string, number> = {};
  for (const [flag, key] of [['maxModelCalls', 'maxModelCalls'], ['maxCostUsd', 'maxCostUsd']] as const) {
    const raw = opts[flag];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new CliError(`--${flag.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} must be a non-negative number (got "${raw}")`);
    budget[key] = value;
  }
  return Object.keys(budget).length ? budget : undefined;
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
