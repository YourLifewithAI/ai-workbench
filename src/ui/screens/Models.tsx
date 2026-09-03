import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModelStatus } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';
import { cn } from '../lib/cn.js';

const AVAILABILITY: Record<ModelStatus['availability'], { label: string; tone: 'good' | 'bad' | 'busy' | 'neutral' }> = {
  ready: { label: 'ready', tone: 'good' },
  'no-credential': { label: 'no key', tone: 'busy' },
  'blocked-by-mode': { label: 'blocked by network mode', tone: 'neutral' },
  unreachable: { label: 'unreachable', tone: 'bad' },
  disabled: { label: 'disabled', tone: 'neutral' },
  'no-adapter': { label: 'no adapter', tone: 'bad' },
};

export function Models() {
  const q = useQuery({ queryKey: ['models'], queryFn: api.models });
  const client = useQueryClient();
  const refresh = useMutation({ mutationFn: api.refreshModels, onSuccess: (data) => client.setQueryData(['models'], data) });

  return (
    <section aria-labelledby="screen-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 id="screen-title" className="text-2xl font-semibold">Models</h1>
        <Button variant="secondary" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? 'Polling…' : 'Refresh local endpoints'}
        </Button>
      </div>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        The catalog is <code className="font-mono">config/models.json</code> in your workspace. Availability is checked, not assumed: local endpoints are polled, cloud models need a credential.
      </p>

      {q.isPending ? <p className="mt-4" role="status">Loading the catalog…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load models: {q.error.message}</p> : null}
      {q.data && q.data.models.length === 0 ? (
        <div className="mt-6"><EmptyState title="No provider configured. Add a key, or use local models offline." /></div>
      ) : null}

      {q.data?.models.length ? (
        <ul className="mt-4 space-y-3">
          {q.data.models.map((m) => <li key={m.id}><ModelCard model={m} pulled={m.baseUrl ? q.data.pulled[m.baseUrl] : undefined} /></li>)}
        </ul>
      ) : null}
    </section>
  );
}

function ModelCard({ model, pulled }: { model: ModelStatus; pulled: string[] | undefined }) {
  const a = AVAILABILITY[model.availability];
  const unavailable = model.availability !== 'ready';
  const caps = model.capabilities as { contextTokens?: number; toolCalling?: string; structuredOutput?: string; reasoning?: string; vision?: boolean };
  const price = (model.pricing[0] ?? null) as { inputPerM?: number; outputPerM?: number } | null;
  const policy = model.dataPolicy as { trainsOnContent?: string; retentionDays?: number; policyUrl?: string };

  return (
    <Card className={cn(unavailable && 'border-dashed bg-gray-50 dark:bg-gray-950')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-mono text-sm font-medium">{model.id}</h2>
          <p className="mt-1 text-xs text-gray-700 dark:text-gray-300">{model.adapter} · {model.locality}{model.baseUrl ? ` · ${model.baseUrl}` : ''}</p>
        </div>
        <Badge tone={a.tone}>{a.label}</Badge>
      </div>
      {model.reason ? <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{model.reason}</p> : null}

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Row k="Context" v={caps.contextTokens ? `${caps.contextTokens.toLocaleString()} tokens` : 'unknown'} />
        <Row k="Tool calling" v={caps.toolCalling ?? 'none'} />
        <Row k="Structured output" v={caps.structuredOutput ?? 'none'} />
        <Row k="Reasoning" v={caps.reasoning ?? 'none'} />
        <Row k="Price" v={price?.inputPerM !== undefined ? `$${price.inputPerM}/M in · $${price.outputPerM}/M out` : 'free or unpriced'} />
        <Row k="Trains on your content" v={policy.trainsOnContent ?? 'unknown'} />
        {policy.retentionDays !== undefined ? <Row k="Retention" v={`${policy.retentionDays} days`} /> : null}
      </dl>
      {pulled?.length ? <p className="mt-2 text-xs text-gray-700 dark:text-gray-300">Pulled on this endpoint: {pulled.join(', ')}</p> : null}
      {policy.policyUrl ? (
        <p className="mt-2 text-xs"><a href={policy.policyUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">Provider data policy</a></p>
      ) : null}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-gray-100 py-1 dark:border-gray-800">
      <dt className="text-gray-700 dark:text-gray-300">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}
