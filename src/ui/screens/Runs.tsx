import { useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { RunSummary } from '../../shared/api/index.js';
import { api, subscribeSse } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { BudgetLine } from '../components/BudgetBar.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/card.js';

/** The states a run can still be stopped from (workflows-and-execution.md §Cancel). */
export const CANCELLABLE = new Set<RunSummary['state']>(['queued', 'running', 'waiting_review', 'waiting_approval']);

export function stateTone(state: RunSummary['state']): 'good' | 'bad' | 'busy' | 'neutral' {
  if (state === 'completed') return 'good';
  if (state === 'failed' || state === 'cancelled' || state === 'interrupted') return 'bad';
  if (state === 'running' || state === 'queued') return 'busy';
  return 'neutral';
}

/** Keeps a screen live: any run-* event on the workspace stream refetches the keys it names (no reload needed). */
export function useLiveRuns(keys: string[] = ['runs']) {
  const client = useQueryClient();
  const watched = keys.join(',');
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const loop = async (): Promise<void> => {
      while (!cancelled) {
        try {
          await subscribeSse('/runs/events', (m) => {
            if (!m.event?.startsWith('run-')) return;
            for (const key of watched.split(',')) void client.invalidateQueries({ queryKey: [key] });
          }, controller.signal);
        } catch {
          // 401 ends the session elsewhere; anything else retries after a pause
        }
        if (!cancelled) await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void loop();
    return () => { cancelled = true; controller.abort(); };
  }, [client, watched]);
}

export function useRunExample() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.createRun({ kind: 'agent', id: 'echo', inputs: { input: 'Hello from the workbench. Echo this back.' }, provider: 'mock' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['runs'] }),
  });
}

export function Runs() {
  const q = useQuery({ queryKey: ['runs'], queryFn: api.runs });
  useLiveRuns();
  const navigate = useNavigate();
  const example = useRunExample();

  return (
    <section aria-labelledby="screen-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 id="screen-title" className="text-2xl font-semibold">Runs</h1>
        <Button variant="secondary" size="sm" onClick={() => example.mutate(undefined, { onSuccess: ({ runId }) => navigate(`/runs/${runId}`) })} disabled={example.isPending}>
          {example.isPending ? 'Starting…' : 'Run the example'}
        </Button>
      </div>
      {example.isError ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{example.error.message}</p> : null}
      {q.isPending ? <p className="mt-4" role="status">Loading runs…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load runs: {q.error.message}</p> : null}
      {q.data && q.data.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="Nothing has run yet. Runs appear here with what they cost and produced.">
            <Button onClick={() => example.mutate(undefined, { onSuccess: ({ runId }) => navigate(`/runs/${runId}`) })} disabled={example.isPending}>Run the example</Button>
          </EmptyState>
        </div>
      ) : null}
      {q.data && q.data.length > 0 ? (
        <ul className="mt-4 space-y-3 md:hidden">
          {q.data.map((r) => (
            <li key={r.id} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{r.agentId ?? r.workflowId ?? r.kind}</p>
                  <p className="mt-0.5 text-xs text-gray-700 dark:text-gray-300">
                    <time dateTime={r.startedAt}>{new Date(r.startedAt).toLocaleString()}</time>
                  </p>
                </div>
                <Badge tone={stateTone(r.state)}>{r.state}</Badge>
              </div>
              <BudgetLine run={r} className="mt-2" />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Link to={`/runs/${r.id}`} className="text-sm text-blue-700 underline underline-offset-4 dark:text-sky-300">Open</Link>
                {CANCELLABLE.has(r.state) ? <CancelButton runId={r.id} /> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {q.data && q.data.length > 0 ? (
        <table className="mt-4 hidden w-full text-left text-sm md:table">
          <caption className="sr-only">Runs, newest first</caption>
          <thead>
            <tr className="border-b border-gray-200 text-gray-600 dark:border-gray-800 dark:text-gray-400">
              <th scope="col" className="py-2 pr-3 font-medium">Run</th>
              <th scope="col" className="py-2 pr-3 font-medium">State</th>
              <th scope="col" className="py-2 pr-3 font-medium">What ran</th>
              <th scope="col" className="py-2 pr-3 font-medium">Started</th>
              <th scope="col" className="py-2 pr-3 font-medium">Budget</th>
              <th scope="col" className="py-2 pr-3 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800">
                <td className="py-2 pr-3"><Link to={`/runs/${r.id}`} className="font-mono text-xs text-blue-700 underline-offset-4 hover:underline dark:text-sky-300">{r.id}</Link></td>
                <td className="py-2 pr-3"><Badge tone={stateTone(r.state)}>{r.state}</Badge></td>
                <td className="py-2 pr-3">{r.agentId ?? r.workflowId ?? '—'}</td>
                <td className="py-2 pr-3"><time dateTime={r.startedAt}>{new Date(r.startedAt).toLocaleString()}</time></td>
                <td className="w-72 py-2 pr-3"><BudgetLine run={r} /></td>
                <td className="py-2 pr-3">{CANCELLABLE.has(r.state) ? <CancelButton runId={r.id} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function CancelButton({ runId }: { runId: string }) {
  const client = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(runId),
    onSuccess: () => client.invalidateQueries({ queryKey: ['runs'] }),
  });
  return (
    <Button variant="secondary" size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
      {cancel.isPending ? 'Cancelling…' : 'Cancel'}
      <span className="sr-only"> run {runId}</span>
    </Button>
  );
}
