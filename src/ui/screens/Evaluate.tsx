// Compare, datasets and experiments (ui.md §Evaluate, D-36, D-50, D-52). Compare is first because it is the eval
// most owners actually use: one step, N models, side by side, and a pick that becomes data.
//
// Every judge-model number says the word "estimate", here and everywhere. Nothing on this screen feeds model
// selection: the numbers are evidence for a person (D-06).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { CompareResponse, ExperimentResults } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';

const money = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function Evaluate() {
  const client = useQueryClient();
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, staleTime: 60_000 });
  const models = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 60_000 });
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: api.datasets });
  const experiments = useQuery({ queryKey: ['experiments'], queryFn: api.experiments, refetchInterval: 2000 });

  const [agentId, setAgentId] = useState('');
  const [input, setInput] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [comparison, setComparison] = useState<CompareResponse | null>(null);
  const [said, setSaid] = useState('');
  const [openExperiment, setOpenExperiment] = useState<string | null>(null);

  const results = useQuery({
    queryKey: ['experiment-results', openExperiment],
    queryFn: () => api.experimentResults(openExperiment!),
    enabled: openExperiment !== null,
    refetchInterval: 2000,
  });

  const compare = useMutation({
    mutationFn: () => api.compare({ agentId, input, models: picked }),
    onSuccess: (data) => { setComparison(data); setSaid(`Ran ${data.panes.length} models.`); },
  });
  const pick = useMutation({
    mutationFn: (winner: { runId: string; modelId: string }) =>
      api.comparePick({
        compareId: comparison!.compareId,
        winner,
        panes: comparison!.panes.map((p) => ({ runId: p.runId, modelId: p.modelId })),
      }),
    onSuccess: (_r, winner) => { setSaid(`Picked ${winner.modelId}. The choice is stored on every pane.`); void client.invalidateQueries({ queryKey: ['runs'] }); },
  });

  const catalog = (models.data?.models ?? []).filter((m) => m.enabled);
  const toggle = (id: string): void => setPicked((current) => (current.includes(id) ? current.filter((m) => m !== id) : [...current, id]));

  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title" className="text-2xl font-semibold">Evaluate</h1>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        Compare models on your own work, and keep the numbers honest. Nothing here chooses a model for you: a score
        is evidence, and a judge model's opinion is an estimate.
      </p>
      <p aria-live="polite" className="sr-only">{said}</p>

      <h2 className="mt-6 text-lg font-medium">Compare</h2>
      <form
        className="mt-2 space-y-3"
        onSubmit={(e) => { e.preventDefault(); if (agentId && input.trim() && picked.length >= 2) compare.mutate(); }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-sm font-medium">Agent</span>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="mt-1 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950"
            >
              <option value="">choose one</option>
              {(agents.data?.agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
            </select>
          </label>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {picked.length < 2 ? 'Pick at least two models.' : `${picked.length} models · about ${money(picked.length * 0.01)} at typical prices`}
          </p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium">Models</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {catalog.map((model) => (
              // 24px is the smallest target WCAG 2.2 accepts, and a checkbox a thumb misses is a checkbox nobody uses.
              <label key={model.id} className="flex items-center gap-2 py-1 text-sm">
                <input type="checkbox" checked={picked.includes(model.id)} onChange={() => toggle(model.id)} className="h-6 w-6" />
                <span className="font-mono text-xs">{model.id}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="block text-sm font-medium">Input</span>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            placeholder="The same thing you would give the agent in a run."
            className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-950"
          />
        </label>
        <Button type="submit" disabled={!agentId || !input.trim() || picked.length < 2 || compare.isPending}>
          {compare.isPending ? 'Running…' : 'Run them side by side'}
        </Button>
        {compare.isError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{compare.error.message}</p> : null}
      </form>

      {comparison ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="compare-panes">
          {comparison.panes.map((pane) => (
            <Card key={pane.runId}>
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-mono text-xs">{pane.modelId}</span>
                <Badge tone={pane.state === 'completed' ? 'good' : 'bad'}>{pane.state}</Badge>
              </p>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {money(pane.costUsd)} · {pane.latencyMs} ms · {pane.tokensIn} in / {pane.tokensOut} out
              </p>
              <pre tabIndex={0} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 font-mono text-xs dark:bg-gray-950">{pane.output || pane.error || '(nothing)'}</pre>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => pick.mutate({ runId: pane.runId, modelId: pane.modelId })} disabled={pick.isPending}>
                  This one is better
                </Button>
                <Link to={`/runs/${pane.runId}`} className="text-sm text-blue-700 underline underline-offset-4 dark:text-sky-300">its trace</Link>
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">Datasets</h2>
      {datasets.data?.length ? (
        <table className="mt-2 w-full text-left text-sm">
          <caption className="sr-only">Datasets, with how many cases each has</caption>
          <thead>
            <tr className="border-b border-gray-200 text-gray-700 dark:border-gray-800 dark:text-gray-300">
              <th scope="col" className="py-2 pr-3 font-medium">Name</th>
              <th scope="col" className="py-2 pr-3 font-medium">Version</th>
              <th scope="col" className="py-2 pr-3 font-medium">Cases</th>
              <th scope="col" className="py-2 pr-3 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {datasets.data.map((dataset) => (
              <tr key={dataset.id} className="border-b border-gray-100 dark:border-gray-800">
                <th scope="row" className="py-2 pr-3 font-normal">{dataset.name}</th>
                <td className="py-2 pr-3">v{dataset.version}</td>
                <td className="py-2 pr-3">{dataset.cases}</td>
                <td className="py-2 pr-3">
                  {dataset.frozen
                    ? <span className="text-gray-700 dark:text-gray-300">frozen — an experiment has run against it</span>
                    : <span className="text-gray-700 dark:text-gray-300">editable</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="mt-2">
          <EmptyState title="No datasets yet. A dataset is a handful of inputs you care about; make one from past run inputs, or import a promptfoo file with `workbench import`." />
        </div>
      )}

      <h2 className="mt-8 text-lg font-medium">Experiments</h2>
      {experiments.data?.length ? (
        <ul className="mt-2 space-y-2">
          {experiments.data.map((experiment) => (
            <li key={experiment.id}>
              <Card>
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <Badge tone={experiment.state === 'completed' ? 'good' : experiment.state === 'failed' ? 'bad' : 'busy'}>{experiment.state}</Badge>
                  <span className="font-medium">{experiment.name}</span>
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    {experiment.target.id} · {experiment.models.length} model{experiment.models.length === 1 ? '' : 's'} · k={experiment.trials}
                  </span>
                </p>
                {experiment.error ? (
                  <p className="mt-1 text-sm text-red-700 dark:text-red-300">{String(experiment.error['message'] ?? experiment.error['reason'])}</p>
                ) : null}
                <div className="mt-2">
                  <Button size="sm" variant="secondary" onClick={() => setOpenExperiment(openExperiment === experiment.id ? null : experiment.id)}>
                    {openExperiment === experiment.id ? 'Hide results' : 'Results'}
                  </Button>
                </div>
                {openExperiment === experiment.id && results.data ? <ResultsTable results={results.data} /> : null}
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2">
          <EmptyState title="No experiments yet. An experiment runs a dataset across models k times each, and reports pass^k beside the mean — because passing three times out of three is a different claim from averaging the same number." />
        </div>
      )}
    </section>
  );
}

function ResultsTable({ results }: { results: ExperimentResults }) {
  const metrics = [...new Set(results.totals.flatMap((t) => Object.keys(t.metrics)))].sort();
  const caseIndex = new Map(results.cases.map((c, i) => [c.id, i + 1]));

  return (
    <div className="mt-3">
      <h3 className="text-sm font-medium">Per model</h3>
      <div className="mt-1 overflow-x-auto" tabIndex={0}>
        <table className="w-full text-left text-sm" data-testid="results-totals">
          <caption className="sr-only">Each model over every case, with pass^k beside the mean</caption>
          <thead>
            <tr className="border-b border-gray-200 text-gray-700 dark:border-gray-800 dark:text-gray-300">
              <th scope="col" className="py-2 pr-3 font-medium">Model</th>
              {metrics.map((metric) => <th key={metric} scope="col" className="py-2 pr-3 font-medium">{metric}</th>)}
              <th scope="col" className="py-2 pr-3 font-medium">Cost</th>
              <th scope="col" className="py-2 pr-3 font-medium">Latency</th>
            </tr>
          </thead>
          <tbody>
            {results.totals.map((total) => (
              <tr key={total.modelId} className="border-b border-gray-100 dark:border-gray-800">
                <th scope="row" className="py-2 pr-3 font-mono text-xs font-normal">{total.modelId}</th>
                {metrics.map((metric) => {
                  const cell = total.metrics[metric];
                  return (
                    <td key={metric} className="py-2 pr-3">
                      {cell ? (
                        <>
                          <span>{cell.mean.toFixed(2)} mean</span>
                          {/* pass^k is a pass/fail idea. A judge answering 0.8 has not failed, so it shows nothing. */}
                          {cell.passK === null
                            ? null
                            : <span className="ml-2 text-gray-600 dark:text-gray-400">pass^k {(cell.passK * 100).toFixed(0)}%</span>}
                          {cell.estimate ? <Badge tone="busy" className="ml-2">estimate</Badge> : null}
                        </>
                      ) : <span className="text-gray-600 dark:text-gray-400">—</span>}
                    </td>
                  );
                })}
                <td className="py-2 pr-3">{money(total.costUsd)}</td>
                <td className="py-2 pr-3">{total.latencyMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-4 text-sm font-medium">Case by case</h3>
      <div className="mt-1 overflow-x-auto" tabIndex={0}>
        <table className="w-full text-left text-sm" data-testid="results-cells">
          <caption className="sr-only">Every case on every model</caption>
          <thead>
            <tr className="border-b border-gray-200 text-gray-700 dark:border-gray-800 dark:text-gray-300">
              <th scope="col" className="py-2 pr-3 font-medium">Case</th>
              <th scope="col" className="py-2 pr-3 font-medium">Model</th>
              <th scope="col" className="py-2 pr-3 font-medium">Trials</th>
              {metrics.map((metric) => <th key={metric} scope="col" className="py-2 pr-3 font-medium">{metric}</th>)}
              <th scope="col" className="py-2 pr-3 font-medium">Traces</th>
            </tr>
          </thead>
          <tbody>
            {results.cells.map((cell) => (
              <tr key={`${cell.caseId}-${cell.modelId}`} className="border-b border-gray-100 dark:border-gray-800">
                <th scope="row" className="py-2 pr-3 font-normal">case {caseIndex.get(cell.caseId) ?? '?'}</th>
                <td className="py-2 pr-3 font-mono text-xs">{cell.modelId}</td>
                <td className="py-2 pr-3">{cell.trials}</td>
                {metrics.map((metric) => {
                  const value = cell.metrics[metric];
                  return (
                    <td key={metric} className="py-2 pr-3">
                      {value ? (
                        <>
                          {value.mean.toFixed(2)}
                          {value.passK === null
                            ? null
                            : <span className="ml-2 text-gray-600 dark:text-gray-400">{value.passK ? 'every trial' : 'not every trial'}</span>}
                          {value.estimate ? <span className="ml-1 text-xs text-amber-800 dark:text-amber-300">estimate</span> : null}
                        </>
                      ) : <span className="text-gray-600 dark:text-gray-400">—</span>}
                    </td>
                  );
                })}
                <td className="py-2 pr-3">
                  {cell.runIds.map((id, i) => (
                    <Link key={id} to={`/runs/${id}`} className="mr-2 text-blue-700 underline underline-offset-4 dark:text-sky-300">{i + 1}</Link>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
