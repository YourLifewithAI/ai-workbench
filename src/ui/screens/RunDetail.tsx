import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { EventRecord } from '../../shared/events.js';
import { api, parseEvent, subscribeSse } from '../lib/api.js';
import { Badge, Card } from '../components/ui/card.js';
import { stateTone } from './Runs.js';

const TERMINAL = new Set(['run-completed', 'run-failed', 'run-cancelled', 'run-interrupted']);

/** Raw timeline (RUN-00): replay then live over the per-run SSE; the summary layer arrives in RUN-01. */
export function RunDetail() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const run = useQuery({ queryKey: ['run', id], queryFn: () => api.run(id), enabled: id !== '' });
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setEvents([]);
    const controller = new AbortController();
    let last = 0;
    subscribeSse(`/runs/${encodeURIComponent(id)}/events`, (m) => {
      const e = parseEvent(m);
      if (!e || e.seq <= last) return;
      last = e.seq;
      setEvents((prev) => [...prev, e]);
      if (TERMINAL.has(e.type)) void client.invalidateQueries({ queryKey: ['run', id] });
    }, controller.signal).catch((e: unknown) => { if (!controller.signal.aborted) setStreamError((e as Error).message); });
    return () => controller.abort();
  }, [id, client]);

  return (
    <section aria-labelledby="screen-title">
      <p className="text-sm"><Link to="/runs" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">← All runs</Link></p>
      <h1 id="screen-title" className="mt-2 text-2xl font-semibold">Run <span className="font-mono text-lg">{id}</span></h1>
      {run.isError ? <p role="alert" className="mt-3 text-red-700 dark:text-red-300">{run.error.message}</p> : null}
      {run.data ? (
        <Card className="mt-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone={stateTone(run.data.state)}>{run.data.state}</Badge>
            <span>{run.data.kind} · {run.data.agentId ?? run.data.workflowId}</span>
            <span>{run.data.spent.modelCalls} model call(s)</span>
            <span>${run.data.spent.costUsd.toFixed(4)}</span>
            <span>{run.data.spent.wallClockMs} ms</span>
          </div>
          {run.data.outputs ? (
            <div className="mt-3">
              <h2 className="text-sm font-medium">Output</h2>
              <pre tabIndex={0} className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-sm dark:bg-gray-950">{formatOutput(run.data.outputs)}</pre>
            </div>
          ) : null}
          {run.data.error !== undefined ? (
            <div className="mt-3">
              <h2 className="text-sm font-medium">Error</h2>
              <pre tabIndex={0} className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-red-50 p-3 font-mono text-sm text-red-900 dark:bg-red-950 dark:text-red-100">{JSON.stringify(run.data.error, null, 2)}</pre>
            </div>
          ) : null}
        </Card>
      ) : null}

      <h2 className="mt-6 text-lg font-medium">Timeline</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400">Every event this run wrote, in order. Expand one to read its full payload; the compiled prompt is under <em>model-started</em>.</p>
      {streamError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{streamError}</p> : null}
      <ol className="mt-3 space-y-2" aria-live="polite" aria-relevant="additions">
        {events.map((e) => <EventItem key={e.seq} e={e} />)}
      </ol>
      {events.length === 0 && !streamError ? <p className="mt-3 text-sm" role="status">Waiting for events…</p> : null}
    </section>
  );
}

function formatOutput(outputs: Record<string, unknown>): string {
  const o = outputs['output'];
  return typeof o === 'string' ? o : JSON.stringify(outputs, null, 2);
}

function EventItem({ e }: { e: EventRecord }) {
  const request = e.type === 'model-started' ? (e.payload['request'] as { system?: string; messages?: { role: string; content: { type: string; text?: string }[] }[]; tools?: unknown[] } | undefined) : undefined;
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
          {request ? (
            <div className="mb-3">
              <h3 className="text-sm font-medium">Compiled prompt</h3>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">System ({request.system?.length ?? 0} chars) · {request.messages?.length ?? 0} message(s) · {request.tools?.length ?? 0} tool(s)</p>
              <pre tabIndex={0} className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">{request.system}</pre>
              {request.messages?.map((m, i) => (
                <div key={i} className="mt-2">
                  <p className="text-xs font-medium uppercase text-gray-600 dark:text-gray-400">{m.role}</p>
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">{m.content.map((c) => c.text ?? `[${c.type}]`).join('\n')}</pre>
                </div>
              ))}
            </div>
          ) : null}
          <h3 className="text-sm font-medium">Payload</h3>
          <pre tabIndex={0} className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">{JSON.stringify(e.payload, null, 2)}</pre>
        </div>
      </details>
    </li>
  );
}

function brief(e: EventRecord): string {
  const p = e.payload;
  const parts: string[] = [];
  if (typeof p['modelId'] === 'string') parts.push(p['modelId']);
  if (typeof p['reason'] === 'string') parts.push(p['reason']);
  if (typeof p['latencyMs'] === 'number') parts.push(`${p['latencyMs']} ms`);
  if (typeof p['costUsd'] === 'number') parts.push(`$${p['costUsd'].toFixed(4)}`);
  if (typeof p['output'] === 'string') parts.push(JSON.stringify(p['output'].slice(0, 50)) + (p['output'].length > 50 ? '…' : ''));
  return parts.join(' · ');
}
