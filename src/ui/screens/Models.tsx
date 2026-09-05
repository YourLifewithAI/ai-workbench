import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CatalogFinding, ModelStatus } from '../../shared/api/index.js';
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
  'price-unknown': { label: 'price unknown', tone: 'bad' },
};

const KIND: Record<CatalogFinding['kind'], { label: string; tone: 'good' | 'bad' | 'busy' | 'neutral'; action: string }> = {
  new: { label: 'new', tone: 'good', action: 'Add, disabled' },
  retired: { label: 'retired', tone: 'bad', action: 'Disable it' },
  repriced: { label: 'repriced', tone: 'busy', action: 'Take the new price' },
  drift: { label: 'changed', tone: 'neutral', action: 'Update the catalog' },
};

export function Models() {
  const q = useQuery({ queryKey: ['models'], queryFn: api.models });
  const client = useQueryClient();
  const refresh = useMutation({ mutationFn: api.refreshModels, onSuccess: (data) => client.setQueryData(['models'], data) });
  const accept = useMutation({ mutationFn: api.acceptFinding, onSuccess: (data) => client.setQueryData(['models'], data) });
  const dismiss = useMutation({ mutationFn: api.dismissFinding, onSuccess: (data) => client.setQueryData(['models'], data) });
  const findings = q.data?.findings ?? [];
  const retiredPins = new Set(findings.filter((f) => f.kind === 'retired' && f.pinnedBy.length).map((f) => f.modelId));
  const discovery = q.data?.discovery;

  return (
    <section aria-labelledby="screen-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 id="screen-title" className="text-2xl font-semibold">Models</h1>
        <Button variant="secondary" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? 'Checking…' : 'Check for changes'}
        </Button>
      </div>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        The catalog is <code className="font-mono">config/models.json</code> in your workspace. Availability is checked, not assumed: local endpoints are polled, cloud models need a credential, and <em>Check for changes</em> asks each provider you hold a key for what it offers now. Nothing it finds is applied until you accept it.
      </p>

      {discovery?.errors.length ? (
        <ul className="mt-3 space-y-1 text-sm text-red-700 dark:text-red-300" role="alert">
          {discovery.errors.map((e) => <li key={e.provider}><span className="font-mono">{e.provider}</span>: {e.message}</li>)}
        </ul>
      ) : null}
      {discovery && !findings.length && !discovery.errors.length ? (
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300" role="status">
          {discovery.checked.length ? `Nothing has changed at ${discovery.checked.join(', ')}.` : 'No provider was asked: none of the adapters that can list has a credential.'}
        </p>
      ) : null}

      {findings.length ? (
        <section aria-labelledby="findings-title" className="mt-4">
          <h2 id="findings-title" className="text-lg font-medium">What changed at the provider</h2>
          <ul className="mt-2 space-y-3" aria-label="Findings">
            {findings.map((f) => (
              <li key={f.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-mono text-sm font-medium">{f.modelId}</h3>
                      {/* The provider's own name for it is data: rendered as text, never written to the catalog. */}
                      {f.displayName ? <p className="mt-1 text-xs text-gray-700 dark:text-gray-300">Provider calls it: {f.displayName}</p> : null}
                    </div>
                    <Badge tone={KIND[f.kind].tone}>{KIND[f.kind].label}</Badge>
                  </div>
                  <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{f.detail}</p>
                  {f.pinnedBy.length ? (
                    <p className="mt-1 text-sm text-red-700 dark:text-red-300">
                      Pinned by {f.pinnedBy.map((p) => (p.agentId ? `${p.agentId} (${p.role})` : `${p.workflowId} › ${p.stepId}`)).join(', ')}.
                    </p>
                  ) : null}
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={() => accept.mutate(f.id)} disabled={accept.isPending || dismiss.isPending} aria-label={`${KIND[f.kind].action}: ${f.modelId}`}>{KIND[f.kind].action}</Button>
                    <Button size="sm" variant="secondary" onClick={() => dismiss.mutate(f.id)} disabled={accept.isPending || dismiss.isPending} aria-label={`Dismiss: ${f.modelId}`}>Dismiss</Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          {accept.isError ? <p className="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">{accept.error.message}</p> : null}
        </section>
      ) : null}

      {q.isPending ? <p className="mt-4" role="status">Loading the catalog…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load models: {q.error.message}</p> : null}
      {q.data && q.data.models.length === 0 ? (
        <div className="mt-6"><EmptyState title="No provider configured. Add a key, or use local models offline." /></div>
      ) : null}

      {q.data?.models.length ? (
        <ul className="mt-4 space-y-3" aria-label="Catalog">
          {q.data.models.map((m) => <li key={m.id}><ModelCard model={m} pulled={m.baseUrl ? q.data.pulled[m.baseUrl] : undefined} retiredPinned={retiredPins.has(m.id)} /></li>)}
        </ul>
      ) : null}
    </section>
  );
}

function ModelCard({ model, pulled, retiredPinned }: { model: ModelStatus; pulled: string[] | undefined; retiredPinned: boolean }) {
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
        <div className="flex gap-2">
          {retiredPinned ? <Badge tone="bad">pinned but retired</Badge> : null}
          <Badge tone={a.tone}>{a.label}</Badge>
        </div>
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
