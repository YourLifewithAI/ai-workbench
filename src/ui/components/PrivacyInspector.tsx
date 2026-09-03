// The Privacy Inspector (ui.md §Runs): where this run's data went, what kind it was, how much, and what the
// provider says it does with it. Bodies are shown as stored — already redacted on the way in (D-33).
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Badge, Card } from '../components/ui/card.js';

export function PrivacyInspector({ runId }: { runId: string }) {
  const q = useQuery({ queryKey: ['privacy', runId], queryFn: () => api.privacy(runId), enabled: runId !== '' });

  if (q.isPending) return <p role="status">Loading…</p>;
  if (q.isError) return <p role="alert" className="text-red-700 dark:text-red-300">{q.error.message}</p>;
  if (!q.data) return null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Network mode when this ran: <span className="font-medium">{q.data.networkMode}</span>.
        {q.data.egress.length === 0 ? ' This run made no attempt to leave the machine.' : ''}
      </p>

      {q.data.destinations.length ? (
        <Card>
          <h3 className="font-medium">Who received it</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {q.data.destinations.map((d) => {
              const policy = (d.dataPolicy ?? {}) as { trainsOnContent?: string; retentionDays?: number };
              return (
                <li key={d.modelId} className="flex flex-wrap items-baseline gap-x-3 border-b border-gray-100 pb-2 last:border-b-0 dark:border-gray-800">
                  <span className="font-mono text-xs">{d.modelId}</span>
                  {d.host ? <span className="text-gray-600 dark:text-gray-400">{d.host}</span> : null}
                  <span className="text-gray-600 dark:text-gray-400">{d.calls} call{d.calls === 1 ? '' : 's'}</span>
                  <span className="text-gray-600 dark:text-gray-400">
                    trains on content: {policy.trainsOnContent ?? 'unknown'}
                    {policy.retentionDays !== undefined ? ` · retained ${policy.retentionDays} days` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {q.data.egress.length ? (
        <div>
          <h3 className="font-medium">Every attempt to leave this machine</h3>
          <ul className="mt-2 space-y-2">
            {q.data.egress.map((e) => (
              <li key={e.id}>
                <details className="rounded-md border border-gray-200 dark:border-gray-800">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-3 py-2 text-sm">
                    <Badge tone={e.decision === 'allowed' ? 'good' : 'bad'}>{e.decision}</Badge>
                    <span className="font-mono text-xs">{e.method} {e.host}</span>
                    {/* Bytes are what *left*: a GET carries none, however large the page that came back. */}
                    <span className="text-gray-600 dark:text-gray-400">{e.purpose} · {e.categories.join(', ') || 'no payload'} · {e.bytes ? `${e.bytes.toLocaleString()} bytes sent` : 'nothing sent in the body'}</span>
                  </summary>
                  <div className="space-y-2 border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                    {e.reason ? <p className="text-sm text-gray-700 dark:text-gray-300">{e.reason}</p> : null}
                    <div>
                      <h4 className="text-sm font-medium">Body as stored <span className="font-normal text-gray-600 dark:text-gray-400">(secrets already redacted)</span></h4>
                      <pre tabIndex={0} className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">{e.bodyRedacted || '(empty)'}</pre>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
