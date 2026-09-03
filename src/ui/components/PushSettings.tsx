// Notifications, per device and per kind (D-61). A device is not a person: the phone should buzz for an
// approval while the laptop, which you are already looking at, stays quiet.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PushEventKind } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { pushAvailability, subscribeToPush, unsubscribeFromPush } from '../lib/push.js';
import { Button } from './ui/button.js';
import { Card } from './ui/card.js';

const EVENTS: { kind: PushEventKind; label: string; note: string }[] = [
  { kind: 'approval-requested', label: 'An agent asks permission', note: 'Refused automatically after 30 minutes, so this is the one worth a buzz.' },
  { kind: 'review-blocking', label: 'A run stops for your review', note: 'It waits as long as you like.' },
  { kind: 'run-failed', label: 'A run fails', note: 'Including one that ran while you were away.' },
  { kind: 'scheduled-run-completed', label: 'A scheduled run finishes', note: 'Only scheduled ones — you are already watching the rest.' },
];

/** A label you will recognise in a list six months from now, guessed from the browser and editable. */
function guessLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This browser';
}

export function PushSettings() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['push'], queryFn: api.pushSubscriptions });
  const availability = pushAvailability();
  const [label, setLabel] = useState(() => (typeof navigator === 'undefined' ? 'This browser' : guessLabel()));
  const invalidate = (): void => { void client.invalidateQueries({ queryKey: ['push'] }); };

  const subscribe = useMutation({ mutationFn: () => subscribeToPush(label), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => unsubscribeFromPush(id), onSuccess: invalidate });
  const setEvents = useMutation({
    mutationFn: (input: { id: string; events: PushEventKind[] }) => api.setPushEvents(input.id, input.events),
    onSuccess: invalidate,
  });

  return (
    <Card>
      <h2 className="font-medium">Notifications</h2>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        A notification carries an id and a kind — never the output, the document, or what the agent said. Tapping it opens the workbench, which fetches the rest once you are back in.
      </p>

      {!q.data?.enabled ? (
        <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">
          Push is off for this workspace. Set <code className="font-mono">push.enabled</code> in <code className="font-mono">config/workbench.json</code> to turn it on.
        </p>
      ) : null}

      {!availability.available ? (
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">{availability.reason}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block font-medium">This device</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1 min-h-11 rounded-md border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            />
          </label>
          <Button onClick={() => subscribe.mutate()} disabled={subscribe.isPending || !q.data?.enabled}>
            {subscribe.isPending ? 'Asking…' : 'Notify this device'}
          </Button>
        </div>
      )}
      {subscribe.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{subscribe.error.message}</p> : null}

      {q.data?.subscriptions.length ? (
        <ul className="mt-4 space-y-3">
          {q.data.subscriptions.map((s) => (
            <li key={s.id} className="rounded border border-gray-200 p-3 dark:border-gray-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{s.deviceLabel ?? 'A device'}</p>
                  <p className="text-xs text-gray-700 dark:text-gray-300">
                    via {s.endpoint} · {s.lastSentAt ? `last notified ${new Date(s.lastSentAt).toLocaleString()}` : 'never notified'}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => remove.mutate(s.id)} disabled={remove.isPending}>
                  Stop<span className="sr-only"> notifying {s.deviceLabel ?? 'this device'}</span>
                </Button>
              </div>
              <fieldset className="mt-2">
                <legend className="text-xs font-medium text-gray-700 dark:text-gray-300">Tell this device about</legend>
                {EVENTS.map((e) => (
                  <label key={e.kind} className="mt-1 flex min-h-11 items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 size-5"
                      checked={s.events.includes(e.kind)}
                      onChange={(event) => setEvents.mutate({
                        id: s.id,
                        events: event.target.checked ? [...s.events, e.kind] : s.events.filter((k) => k !== e.kind),
                      })}
                    />
                    <span>
                      {e.label}
                      <span className="block text-xs text-gray-600 dark:text-gray-400">{e.note}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
