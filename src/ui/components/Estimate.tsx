// What a run will cost, before the button is pressed (finish list F2). One line under the form, live as the
// inputs change, honest about being an estimate, and read against the cap the run would actually stop at.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EstimateRequest } from '../../shared/api/index.js';
import { money } from '../../shared/summary.js';
import { api } from '../lib/api.js';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function Estimate({ request, mock }: { request: EstimateRequest; mock: boolean }) {
  const key = useDebounced(JSON.stringify(request), 400);
  const q = useQuery({ queryKey: ['estimate', key], queryFn: () => api.estimate(JSON.parse(key) as EstimateRequest), staleTime: 30_000 });
  if (mock) return <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="estimate">On the mock: no bill. The cost shown after the run is what the same prompts would have cost on the models named.</p>;
  if (q.isPending) return <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="estimate">Estimating…</p>;
  if (q.isError) return <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="estimate">No estimate: {q.error.message}</p>;
  const e = q.data;
  const unready = e.steps.filter((s) => s.modelId === null && s.agentId !== null);
  const modelled = e.steps.filter((s) => s.modelId);
  // Every modelled step is a local model, or nothing is modelled: there is no bill, and "$0.00" would read as a price.
  const free = modelled.length > 0 && modelled.every((s) => s.lowUsd === 0 && s.highUsd === 0);
  const notes = [...new Set(e.steps.filter((s) => s.note && s.modelId).map((s) => s.note!))];
  return (
    <div className="text-sm" data-testid="estimate">
      <p>
        <span className="font-medium">{free ? 'No bill' : `About ${money(e.lowUsd)}${e.highUsd > e.lowUsd ? ` to ${money(e.highUsd)}` : ''}`}</span>
        <span className="text-gray-700 dark:text-gray-300"> · ~{tokens(e.promptTokens)} tokens in · {modelled.map((s) => `${s.stepId} on ${s.modelId}`).join(', ') || 'no model call'}</span>
      </p>
      <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{free && notes.length ? `${notes.join(' ')} ` : ''}{e.caveat}</p>
      {unready.length ? <p role="alert" className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">{unready.map((s) => `${s.stepId}: ${s.note}`).join(' ')}</p> : null}
    </div>
  );
}
