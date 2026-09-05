import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CatalogFinding, ModelListResponse, ModelStatus } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';
import { cn } from '../lib/cn.js';
import { Prose, ScreenTitle, SectionTitle, Subheading } from '../components/ui/text.js';
import { Link } from 'react-router-dom';

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
        <ScreenTitle>Models</ScreenTitle>
        <Button variant="secondary" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? 'Checking…' : 'Check for changes'}
        </Button>
      </div>
      <Prose className="mt-1">
        The catalog is <code className="font-mono">config/models.json</code> in your workspace. Availability is checked, not assumed: local endpoints are polled, cloud models need a credential, and <em>Check for changes</em> asks each provider you hold a key for what it offers now. Nothing it finds is applied until you accept it.
      </Prose>

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
        <section aria-labelledby="findings-title" className="mt-6">
          <SectionTitle id="findings-title">What changed at the provider</SectionTitle>
          <ul className="mt-2 space-y-3" aria-label="Findings">
            {findings.map((f) => (
              <li key={f.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Subheading className="font-mono">{f.modelId}</Subheading>
                      {/* The provider's own name for it is data: rendered as text, never written to the catalog. */}
                      {f.displayName ? <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Provider calls it: {f.displayName}</p> : null}
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
        <div className="mt-6">
          <EmptyState title="No provider configured. Add a key, or use local models offline.">
            <Button asChild><Link to="/settings">Add a key</Link></Button>
          </EmptyState>
        </div>
      ) : null}

      {q.data?.models.length ? (
        <ul className="mt-4 space-y-3" aria-label="Catalog">
          {q.data.models.map((m) => (
            <li key={m.id}>
              <ModelCard
                model={m}
                pulled={m.baseUrl ? q.data.pulled[m.baseUrl] : undefined}
                retiredPinned={retiredPins.has(m.id)}
                onChanged={(data) => client.setQueryData(['models'], data)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ModelCard({ model, pulled, retiredPinned, onChanged }: { model: ModelStatus; pulled: string[] | undefined; retiredPinned: boolean; onChanged: (data: ModelListResponse) => void }) {
  const a = AVAILABILITY[model.availability];
  const unavailable = model.availability !== 'ready';
  const caps = model.capabilities as { contextTokens?: number; toolCalling?: string; structuredOutput?: string; reasoning?: string; vision?: boolean };
  const rows = model.pricing as { effectiveFrom: string; inputPerM: number; outputPerM: number }[];
  // The row in effect: the newest whose date has arrived. A cloud model with none is unusable until a person types one in (D-65).
  const now = Date.now();
  const price = rows.filter((r) => Date.parse(r.effectiveFrom) <= now).sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? 1 : -1))[0] ?? null;
  const needsPrice = model.locality === 'cloud' && model.adapter !== 'mock' && price === null;
  const policy = model.dataPolicy as { trainsOnContent?: string; retentionDays?: number; policyUrl?: string };
  const [inputPerM, setInputPerM] = useState('');
  const [outputPerM, setOutputPerM] = useState('');
  const setPrice = useMutation({ mutationFn: () => api.setPrice(model.id, { inputPerM: Number(inputPerM), outputPerM: Number(outputPerM) }), onSuccess: onChanged });
  const setEnabled = useMutation({ mutationFn: (enabled: boolean) => api.setEnabled(model.id, enabled), onSuccess: onChanged });

  return (
    <Card className={cn(unavailable && 'border-dashed bg-gray-50 dark:bg-gray-950')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Subheading as="h2" className="font-mono">{model.id}</Subheading>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{model.adapter} · {model.locality}{model.baseUrl ? ` · ${model.baseUrl}` : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          {retiredPinned ? <Badge tone="bad">pinned but retired</Badge> : null}
          <Badge tone={a.tone}>{a.label}</Badge>
          {model.adapter !== 'mock' ? (
            <Button size="sm" variant="secondary" onClick={() => setEnabled.mutate(!model.enabled)} disabled={setEnabled.isPending} aria-label={`${model.enabled ? 'Disable' : 'Enable'}: ${model.id}`}>
              {model.enabled ? 'Disable' : 'Enable'}
            </Button>
          ) : null}
        </div>
      </div>
      {model.reason ? <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{model.reason}</p> : null}
      {needsPrice ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950"
          onSubmit={(e) => { e.preventDefault(); if (inputPerM !== '' && outputPerM !== '') setPrice.mutate(); }}
          aria-label={`Set a price: ${model.id}`}
        >
          <p className="w-full text-sm">No price is on record, so this model cannot be picked: every cost cap depends on the number. Copy it from the provider's pricing page, in dollars per million tokens.</p>
          <label className="block">
            <span className="block text-xs font-medium">Input, $ per million</span>
            <input type="number" min="0" step="0.01" required value={inputPerM} onChange={(e) => setInputPerM(e.target.value)} className="mt-1 w-32 rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950" />
          </label>
          <label className="block">
            <span className="block text-xs font-medium">Output, $ per million</span>
            <input type="number" min="0" step="0.01" required value={outputPerM} onChange={(e) => setOutputPerM(e.target.value)} className="mt-1 w-32 rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950" />
          </label>
          <Button type="submit" size="sm" disabled={setPrice.isPending}>Save price</Button>
          {setPrice.isError ? <p role="alert" className="w-full text-sm text-red-700 dark:text-red-300">{setPrice.error.message}</p> : null}
        </form>
      ) : null}
      {setEnabled.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{setEnabled.error.message}</p> : null}

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Row k="Context" v={caps.contextTokens ? `${caps.contextTokens.toLocaleString()} tokens` : 'unknown'} />
        <Row k="Tool calling" v={caps.toolCalling ?? 'none'} />
        <Row k="Structured output" v={caps.structuredOutput ?? 'none'} />
        <Row k="Reasoning" v={caps.reasoning ?? 'none'} />
        <Row k="Price" v={price?.inputPerM !== undefined ? `$${price.inputPerM}/M in · $${price.outputPerM}/M out` : 'free or unpriced'} />
        <Row k="Trains on your content" v={policy.trainsOnContent ?? 'unknown'} />
        {policy.retentionDays !== undefined ? <Row k="Retention" v={`${policy.retentionDays} days`} /> : null}
      </dl>
      {pulled?.length ? <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">Pulled on this endpoint: {pulled.join(', ')}</p> : null}
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
