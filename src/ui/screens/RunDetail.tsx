import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { EventRecord } from '../../shared/events.js';
import type { RunDetail as RunDetailShape, StepSummary } from '../../shared/api/index.js';
import { money, seconds, summarizeRun, summarizeStep } from '../../shared/summary.js';
import { api, parseEvent, subscribeSse } from '../lib/api.js';
import { Badge, Card } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import { SummaryCard } from '../components/SummaryCard.js';
import { PrivacyInspector } from '../components/PrivacyInspector.js';
import { BudgetBar } from '../components/BudgetBar.js';
import { RunGraph } from '../components/RunGraph.js';
import { CANCELLABLE, stateTone } from './Runs.js';
import { ScreenTitle, SectionTitle, Subheading } from '../components/ui/text.js';

const TERMINAL = new Set(['run-completed', 'run-failed', 'run-cancelled', 'run-interrupted']);

interface Delta { runId: string; stepId: string; modelId: string; kind: 'text' | 'reasoning'; text: string }

/** Summary first, then steps and their model calls, then the raw timeline (D-58: progressive disclosure). */
export function RunDetail() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const run = useQuery({ queryKey: ['run', id], queryFn: () => api.run(id), enabled: id !== '' });
  // Cached across screens by React Query; it only supplies the agent's display name for the summary sentence.
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, staleTime: 60_000 });
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [streamError, setStreamError] = useState<string | null>(null);
  const [tab, setTab] = useState<'trace' | 'privacy'>('trace');

  useEffect(() => {
    if (!id) return;
    setEvents([]);
    setStreaming({});
    const controller = new AbortController();
    let last = 0;
    subscribeSse(`/runs/${encodeURIComponent(id)}/events`, (m) => {
      if (m.event === 'model-delta') {
        const d = JSON.parse(m.data) as Delta;
        if (d.kind !== 'text') return;
        setStreaming((prev) => ({ ...prev, [d.stepId]: (prev[d.stepId] ?? '') + d.text }));
        return;
      }
      const e = parseEvent(m);
      if (!e || e.seq <= last) return;
      last = e.seq;
      setEvents((prev) => [...prev, e]);
      if (e.type === 'model-aborted' || e.type === 'step-completed' || e.type === 'step-failed') {
        setStreaming((prev) => { const next = { ...prev }; delete next[e.stepId ?? '']; return next; });
      }
      if (TERMINAL.has(e.type)) void client.invalidateQueries({ queryKey: ['run', id] });
    }, controller.signal).catch((e: unknown) => { if (!controller.signal.aborted) setStreamError((e as Error).message); });
    return () => controller.abort();
  }, [id, client]);

  const workflow = useQuery({
    queryKey: ['workflow', run.data?.workflowId ?? ''],
    queryFn: () => api.workflow(run.data!.workflowId!),
    enabled: Boolean(run.data?.workflowId),
    staleTime: 60_000,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['run', id] }),
  });

  const agentName = agents.data?.agents.find((a) => a.id === run.data?.agentId)?.name;
  const summary = useMemo(() => (run.data ? summarizeRun(run.data, events, agentName) : null), [run.data, events, agentName]);

  return (
    <section aria-labelledby="screen-title">
      <p className="text-sm"><Link to="/runs" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">← All runs</Link></p>
      <ScreenTitle className="mt-2">Run <span className="font-mono text-lg">{id}</span></ScreenTitle>
      {run.isError ? <p role="alert" className="mt-3 text-red-700 dark:text-red-300">{run.error.message}</p> : null}

      {summary ? <SummaryCard summary={summary} className="mt-4" /> : null}

      {run.data ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <Badge tone={stateTone(run.data.state)}>{run.data.state}</Badge>
            <span>{run.data.kind} · {run.data.agentId ?? run.data.workflowId}</span>
            <span>{money(run.data.spent.costUsd)} stored</span>
            <span>{seconds(run.data.spent.wallClockMs)}</span>
            {CANCELLABLE.has(run.data.state) ? (
              <Button variant="secondary" size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {cancel.isPending ? 'Cancelling…' : 'Cancel run'}
              </Button>
            ) : null}
          </div>
          {cancel.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{cancel.error.message}</p> : null}

          <Card className="mt-4"><BudgetBar run={run.data} /></Card>

          {workflow.data ? (
            <>
              <SectionTitle className="mt-6">Graph</SectionTitle>
              <Card className="mt-2"><RunGraph workflow={workflow.data} states={run.data.steps} /></Card>
            </>
          ) : null}

          <div className="mt-6 flex gap-1 border-b border-gray-200 dark:border-gray-800" role="tablist" aria-label="Run views">
            {(['trace', 'privacy'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-t px-3 py-2 text-sm font-medium ${tab === t ? 'border-b-2 border-blue-700 dark:border-sky-300' : 'text-gray-600 dark:text-gray-400'}`}
              >
                {t === 'trace' ? 'Trace' : 'Privacy Inspector'}
              </button>
            ))}
          </div>

          {tab === 'privacy' ? <div className="mt-4"><PrivacyInspector runId={id} /></div> : null}

          {tab === 'trace' ? <><SectionTitle className="mt-6">Steps</SectionTitle>
          <div className="mt-2 space-y-4">
            {run.data.steps.map((step) => (
              <StepBlock key={step.stepId} step={step} events={events} streaming={streaming[step.stepId]} run={run.data!} />
            ))}
          </div>

      </> : null}
        </>
      ) : null}

      {tab === 'trace' ? (
        <>
      <SectionTitle className="mt-8">Raw timeline</SectionTitle>
      <p className="text-sm text-gray-600 dark:text-gray-400">Every event this run wrote, in order — the same lines <code className="font-mono">workbench trace</code> prints.</p>
      {streamError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{streamError}</p> : null}
      <ol className="mt-3 space-y-2" aria-live="polite" aria-relevant="additions">
        {events.map((e) => <EventItem key={e.seq} e={e} />)}
      </ol>
      {events.length === 0 && !streamError ? <p className="mt-3 text-sm" role="status">Waiting for events…</p> : null}
        </>
      ) : null}
    </section>
  );
}

function StepBlock({ step, events, streaming, run }: { step: StepSummary; events: EventRecord[]; streaming: string | undefined; run: RunDetailShape }) {
  const summary = summarizeStep(step, events);
  const calls = events.filter((e) => e.stepId === step.stepId && (e.type === 'model-started' || e.type === 'model-completed' || e.type === 'model-aborted'));
  const output = events.find((e) => e.type === 'step-completed' && e.stepId === step.stepId)?.payload['output'];
  const finalText = typeof output === 'string' ? output : (run.outputs?.['output'] as string | undefined);

  return (
    <Card>
      <SummaryCard summary={summary} className="border-0 border-l-4 bg-transparent p-0 pl-3 dark:bg-transparent" />

      {streaming !== undefined ? (
        <div className="mt-3">
          <Subheading>Streaming<span className="sr-only"> output, updating live</span></Subheading>
          <pre tabIndex={0} aria-live="polite" className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-sm dark:bg-gray-950">{streaming}<span aria-hidden="true" className="opacity-60">▌</span></pre>
        </div>
      ) : finalText ? (
        <div className="mt-3">
          <Subheading>Output</Subheading>
          <pre tabIndex={0} className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-sm dark:bg-gray-950">{finalText}</pre>
        </div>
      ) : null}

      {calls.length ? (
        <div className="mt-3">
          <Subheading>Model calls</Subheading>
          <ul className="mt-1 space-y-2">
            {calls.filter((e) => e.type === 'model-completed' || e.type === 'model-aborted').map((e) => (
              <li key={e.seq}><ModelCallBlock completed={e} started={calls.find((s) => s.type === 'model-started' && s.seq < e.seq)} /></li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function ModelCallBlock({ completed, started }: { completed: EventRecord; started: EventRecord | undefined }) {
  const p = completed.payload;
  const usage = (p['usage'] ?? {}) as { input?: number; output?: number; reasoning?: number; cachedInput?: number };
  const failed = completed.type === 'model-aborted';
  const request = started?.payload['request'] as { system?: string; messages?: { role: string; content: { type: string; text?: string }[] }[]; tools?: unknown[] } | undefined;
  const response = p['response'] as { content?: { type: string; text?: string }[] } | undefined;

  return (
    <details className="rounded-md border border-gray-200 dark:border-gray-800">
      <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-3 py-2 text-sm">
        <span className="font-mono text-xs">{String(p['modelId'] ?? '')}</span>
        {failed ? <Badge tone="bad">{String(p['reason'] ?? 'aborted')}</Badge> : <Badge tone="good">ok</Badge>}
        {!failed ? <span className="text-gray-600 dark:text-gray-400">{usage.input ?? 0} in / {usage.output ?? 0} out{usage.reasoning ? ` (+${usage.reasoning} reasoning)` : ''} · {money(Number(p['costUsd'] ?? 0))} · {seconds(Number(p['latencyMs'] ?? 0))}</span> : null}
      </summary>
      <div className="space-y-3 border-t border-gray-100 px-3 py-2 dark:border-gray-800">
        {request ? (
          <div>
            <Subheading as="h4">Compiled prompt</Subheading>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">System ({request.system?.length ?? 0} chars) · {request.messages?.length ?? 0} message(s) · {request.tools?.length ?? 0} tool(s) · prompt {String(p['promptVersion'] ?? '').replace('sha256:', '').slice(0, 12)} · agent {String(p['agentVersion'] ?? '').replace('sha256:', '').slice(0, 12)}</p>
            <pre tabIndex={0} className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">{request.system}</pre>
            {request.messages?.map((m, i) => (
              <div key={i} className="mt-2">
                <p className="text-xs font-medium uppercase text-gray-600 dark:text-gray-400">{m.role}</p>
                <pre tabIndex={0} className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">{m.content.map((c) => c.text ?? `[${c.type}]`).join('\n')}</pre>
              </div>
            ))}
          </div>
        ) : null}
        {response?.content?.length ? (
          <div>
            <Subheading as="h4">Response</Subheading>
            <pre tabIndex={0} className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">{response.content.map((c) => c.text ?? `[${c.type}]`).join('\n')}</pre>
          </div>
        ) : null}
        {failed ? (
          <div>
            <Subheading as="h4">Error</Subheading>
            <pre tabIndex={0} className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-3 font-mono text-xs text-red-900 dark:bg-red-950 dark:text-red-100">{JSON.stringify(p['error'], null, 2)}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function EventItem({ e }: { e: EventRecord }) {
  return (
    <li className="rounded-md border border-gray-200 dark:border-gray-800">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-3 py-2 text-sm">
          <span className="font-mono text-xs text-gray-600 dark:text-gray-400">#{e.seq}</span>
          <time dateTime={e.ts} className="font-mono text-xs text-gray-600 dark:text-gray-400">{e.ts.slice(11, 23)}</time>
          <span className="font-medium" data-testid="event-type">{e.type}</span>
          {e.stepId ? <Badge>{e.stepId}</Badge> : null}
          <span className="text-gray-600 dark:text-gray-400">{brief(e)}</span>
        </summary>
        <div className="border-t border-gray-100 px-3 py-2 dark:border-gray-800">
          <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">{JSON.stringify(e.payload, null, 2)}</pre>
        </div>
      </details>
    </li>
  );
}

function brief(e: EventRecord): string {
  const p = e.payload;
  const parts: string[] = [];
  // The memory events carry neither a model nor a reason, and "memory-retrieved" with no line beside it tells a
  // reader nothing about what the model was actually working from.
  if (e.type === 'memory-retrieved' && Array.isArray(p['items'])) {
    const items = p['items'] as { trust: string }[];
    const untrusted = items.filter((i) => i.trust === 'untrusted').length;
    return `${items.length} item${items.length === 1 ? '' : 's'}${untrusted ? `, ${untrusted} untrusted` : ''}`;
  }
  if ((e.type === 'memory-written' || e.type === 'memory-redacted') && typeof p['scope'] === 'string') {
    return [p['scope'] + ':' + String(p['ownerId'] ?? ''), typeof p['trust'] === 'string' ? p['trust'] : null].filter(Boolean).join(' · ');
  }
  if (typeof p['modelId'] === 'string') parts.push(p['modelId']);
  if (typeof p['reason'] === 'string') parts.push(p['reason']);
  if (typeof p['latencyMs'] === 'number') parts.push(seconds(p['latencyMs']));
  if (typeof p['costUsd'] === 'number') parts.push(money(p['costUsd']));
  if (typeof p['output'] === 'string') parts.push(JSON.stringify(p['output'].slice(0, 50)) + (p['output'].length > 50 ? '…' : ''));
  return parts.join(' · ');
}
