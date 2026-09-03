// `workbench datasets`, `experiments` and `compare` — the CLI half of the Evaluate screen (ui.md §UX rules).
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { CompareResponse, DatasetSummary, ExperimentResults, ExperimentSummary } from '../../../shared/api/index.js';
import { CliError, connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

export function registerEvaluate(program: Command, bootstrap: Bootstrap): void {
  const datasets = program.command('datasets').description('the inputs you evaluate against');

  datasets
    .command('list')
    .description('every dataset, with how many cases it has')
    .action(async (_opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const { datasets: rows } = await handle.request<{ datasets: DatasetSummary[] }>('GET', '/datasets');
          if (wantsJson(cmd)) return outJson({ datasets: rows });
          if (!rows.length) return out('No datasets yet.');
          for (const d of rows) out(`${d.id}  ${d.name} v${d.version}  ${d.cases} case(s)  ${d.frozen ? 'frozen' : 'editable'}`);
        } finally {
          await handle.close();
        }
      }),
    );

  datasets
    .command('create <name>')
    .description('a new dataset, optionally from a promptfoo-shaped file')
    .option('--from <file>', 'a promptfoo-compatible JSON file to import the cases from')
    .action(async (name: string, opts: { from?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const dataset = opts.from
            ? await handle.request<DatasetSummary>('POST', `/datasets/import?name=${encodeURIComponent(name)}`, readJson(opts.from))
            : await handle.request<DatasetSummary>('POST', '/datasets', { name, cases: [] });
          if (wantsJson(cmd)) return outJson(dataset);
          out(`${dataset.id}  ${dataset.name} v${dataset.version}  ${dataset.cases} case(s)`);
        } finally {
          await handle.close();
        }
      }),
    );

  datasets
    .command('export <id>')
    .description('write it out in the promptfoo-compatible shape; every value is redacted')
    .option('--out <file>', 'write to a file rather than stdout')
    .action(async (id: string, opts: { out?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const file = await handle.request<unknown>('GET', `/datasets/${encodeURIComponent(id)}/export`);
          const text = JSON.stringify(file, null, 2);
          if (opts.out) {
            fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
            fs.writeFileSync(path.resolve(opts.out), `${text}\n`);
            if (!wantsJson(cmd)) out(`wrote ${opts.out}`);
            else outJson(file);
            return;
          }
          out(text);
        } finally {
          await handle.close();
        }
      }),
    );

  const experiments = program.command('experiments').description('a dataset across models, k times each');

  experiments
    .command('run <name>')
    .description('start one; it runs in the background and `results` shows what it found')
    .requiredOption('--dataset <id>', 'the dataset to run')
    .requiredOption('--agent <id>', 'the agent to run it against')
    .requiredOption('--models <ids>', 'comma-separated model ids')
    .option('--trials <k>', 'trials per case (default 3)', '3')
    .option('--max-cost <usd>', 'stop at this much spent')
    .option('--project <slug>', 'file anything the runs write here')
    .option('--evaluators <file>', 'a JSON array of evaluator specs')
    .action(async (name: string, opts: { dataset: string; agent: string; models: string; trials: string; maxCost?: string; project?: string; evaluators?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap, requireLive: false });
        try {
          const experiment = await handle.request<ExperimentSummary>('POST', '/experiments', {
            name,
            datasetId: opts.dataset,
            target: { kind: 'agent', id: opts.agent },
            models: opts.models.split(',').map((m) => m.trim()).filter(Boolean),
            trials: Number(opts.trials),
            ...(opts.evaluators ? { evaluators: readJson(opts.evaluators) } : {}),
            ...(opts.maxCost ? { budgets: { maxCostUsd: Number(opts.maxCost) } } : {}),
            ...(opts.project ? { project: opts.project } : {}),
          });
          if (wantsJson(cmd)) return outJson(experiment);
          out(`${experiment.id}  ${experiment.name}  ${experiment.state}`);
        } finally {
          await handle.close();
        }
      }),
    );

  experiments
    .command('results <id>')
    .description('the table: every case by model, with pass^k beside the mean')
    .action(async (id: string, _opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const results = await handle.request<ExperimentResults>('GET', `/experiments/${encodeURIComponent(id)}/results`);
          if (wantsJson(cmd)) return outJson(results);
          out(`${results.experiment.name}  ${results.experiment.state}`);
          for (const total of results.totals) {
            const metrics = Object.entries(total.metrics)
              .map(([metric, v]) => `${metric} ${v.mean.toFixed(2)}${v.passK === null ? '' : ` (pass^k ${(v.passK * 100).toFixed(0)}%)`}${v.estimate ? ' [estimate]' : ''}`)
              .join('  ');
            out(`  ${total.modelId.padEnd(28)} ${metrics || 'no scores'}  $${total.costUsd.toFixed(4)}  ${total.latencyMs} ms`);
          }
        } finally {
          await handle.close();
        }
      }),
    );

  program
    .command('compare')
    .description('one agent, one input, N models, side by side')
    .requiredOption('--agent <id>', 'the agent to run')
    .requiredOption('--models <ids>', 'comma-separated model ids, at least two')
    .requiredOption('--input <text>', 'what to give it')
    .option('--project <slug>')
    .action(async (opts: { agent: string; models: string; input: string; project?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const result = await handle.request<CompareResponse>('POST', '/compare', {
            agentId: opts.agent,
            input: opts.input,
            models: opts.models.split(',').map((m) => m.trim()).filter(Boolean),
            ...(opts.project ? { project: opts.project } : {}),
          });
          if (wantsJson(cmd)) return outJson(result);
          for (const pane of result.panes) {
            out(`— ${pane.modelId}  ${pane.state}  $${pane.costUsd.toFixed(4)}  ${pane.latencyMs} ms  run ${pane.runId}`);
            out(pane.output || pane.error || '(nothing)');
            out('');
          }
          out(`Pick one with: workbench compare pick --compare ${result.compareId} --run <runId>`);
        } finally {
          await handle.close();
        }
      }),
    );
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
