// Following one run as it happens: the events as they land and the text as it streams, over the same fetch-based
// SSE every other live view uses (never EventSource, so the token rides along). The run's page and the board's
// composer both call this; there is one follower, not two.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EventRecord } from '../../shared/events.js';
import { parseEvent, subscribeSse } from './api.js';

export const TERMINAL = new Set(['run-completed', 'run-failed', 'run-cancelled', 'run-interrupted']);

interface Delta { runId: string; stepId: string; modelId: string; kind: 'text' | 'reasoning'; text: string }

export interface RunStream {
  events: EventRecord[];
  /** Text streaming per step, until the step completes. */
  streaming: Record<string, string>;
  error: string | null;
  /** True once a terminal run event has arrived. */
  done: boolean;
}

/**
 * Follows `id` while it is set. On a terminal event the run's own query is refetched, and so is every key in
 * `keys` — a caller names what it is showing (the thread, the board) and it refreshes itself.
 */
export function useRunStream(id: string | null, keys: string[] = []): RunStream {
  const client = useQueryClient();
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const watched = keys.join(',');

  useEffect(() => {
    setEvents([]);
    setStreaming({});
    setError(null);
    setDone(false);
    if (!id) return;
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
      if (TERMINAL.has(e.type)) {
        setDone(true);
        void client.invalidateQueries({ queryKey: ['run', id] });
        for (const key of watched.split(',')) if (key) void client.invalidateQueries({ queryKey: [key] });
      }
    }, controller.signal).catch((err: unknown) => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [id, client, watched]);

  return { events, streaming, error, done };
}
