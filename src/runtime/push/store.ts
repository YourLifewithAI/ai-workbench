// Push subscriptions and dispatch (D-61). A payload is `{ kind, id, runId }` and nothing else: a notification
// travels through a third party's servers, so it carries a pointer, never the thing it points at (SEC-32).
import { ulid } from 'ulid';
import webpush from 'web-push';
import type { Db } from '../db/index.js';
import type { Logger } from '../log/index.js';
import type { PushEventKind, PushSubscription } from '../../shared/api/index.js';
import type { VapidKeys } from './vapid.js';

/** The four moments worth a buzz. Everything else is something you find when you next look (D-61). */
export const PUSH_EVENTS: readonly PushEventKind[] = ['approval-requested', 'review-blocking', 'run-failed', 'scheduled-run-completed'] as const;

/** What the phone shows. Deliberately generic: the title is the *kind*, never the content. */
const TITLES: Record<PushEventKind, string> = {
  'approval-requested': 'An agent is asking permission',
  'review-blocking': 'A run is waiting for your review',
  'run-failed': 'A run failed',
  'scheduled-run-completed': 'A scheduled run finished',
};

/** Where tapping it lands. The app resolves the id; the notification never carries what is behind it. */
function deepLink(kind: PushEventKind, runId: string): string {
  switch (kind) {
    case 'approval-requested': return '/dashboard';
    case 'review-blocking': return '/review';
    default: return `/runs/${runId}`;
  }
}

interface Row {
  id: string; endpoint: string; keys_json: string; device_label: string | null;
  events_json: string; last_sent_at: string | null; gone_at: string | null; created_at: string;
}

export interface PushSender {
  (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number }): Promise<{ statusCode: number }>;
}

export interface PushDeps {
  db: Db;
  log: Logger;
  keys: () => VapidKeys;
  /** Injected so a test can watch what would have been sent without a push service. */
  send?: PushSender | undefined;
  enabled: () => boolean;
}

export class PushStore {
  constructor(private readonly deps: PushDeps) {}

  subscribe(input: { endpoint: string; keys: { p256dh: string; auth: string }; deviceLabel?: string | undefined; events?: PushEventKind[] | undefined }): PushSubscription {
    const wanted = (input.events ?? PUSH_EVENTS).filter((e) => PUSH_EVENTS.includes(e));
    const existing = this.deps.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(input.endpoint) as Row | undefined;
    if (existing) {
      // Re-subscribing is how a device comes back after being switched off; it should not become a second row.
      this.deps.db.prepare('UPDATE push_subscriptions SET keys_json = ?, device_label = ?, events_json = ?, gone_at = NULL WHERE id = ?')
        .run(JSON.stringify(input.keys), input.deviceLabel ?? existing.device_label, JSON.stringify(wanted), existing.id);
      return this.toSummary(this.row(existing.id)!);
    }
    const row: Row = {
      id: ulid(), endpoint: input.endpoint, keys_json: JSON.stringify(input.keys),
      device_label: input.deviceLabel ?? null, events_json: JSON.stringify(wanted),
      last_sent_at: null, gone_at: null, created_at: new Date().toISOString(),
    };
    this.deps.db.prepare('INSERT INTO push_subscriptions (id, endpoint, keys_json, device_label, events_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.endpoint, row.keys_json, row.device_label, row.events_json, row.created_at);
    return this.toSummary(row);
  }

  unsubscribe(id: string): boolean {
    return this.deps.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes > 0;
  }

  setEvents(id: string, events: PushEventKind[]): PushSubscription | null {
    const row = this.row(id);
    if (!row) return null;
    this.deps.db.prepare('UPDATE push_subscriptions SET events_json = ? WHERE id = ?').run(JSON.stringify(events.filter((e) => PUSH_EVENTS.includes(e))), id);
    return this.toSummary(this.row(id)!);
  }

  list(): PushSubscription[] {
    return (this.deps.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as Row[]).map((r) => this.toSummary(r));
  }

  /**
   * Sends one kind to every device that asked for it. Returns what was sent, so a test can assert the payload
   * without a push service — and so the caller can log how many phones heard about it.
   */
  async notify(kind: PushEventKind, ids: { id: string; runId: string }): Promise<{ sent: number; payload: string }> {
    // `{ kind, id, runId }` and nothing else. No title from the workspace, no document path, no output.
    const payload = JSON.stringify({
      kind,
      id: ids.id,
      runId: ids.runId,
      title: TITLES[kind],
      url: deepLink(kind, ids.runId),
    });
    if (!this.deps.enabled()) return { sent: 0, payload };

    const rows = (this.deps.db.prepare('SELECT * FROM push_subscriptions WHERE gone_at IS NULL').all() as Row[])
      .filter((r) => (JSON.parse(r.events_json) as PushEventKind[]).includes(kind));
    if (!rows.length) return { sent: 0, payload };

    const keys = this.deps.keys();
    const send = this.deps.send ?? ((subscription, body, options) => webpush.sendNotification(subscription, body, options) as Promise<{ statusCode: number }>);
    let sent = 0;
    for (const row of rows) {
      try {
        await send(
          { endpoint: row.endpoint, keys: JSON.parse(row.keys_json) as { p256dh: string; auth: string } },
          payload,
          { vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 },
        );
        this.deps.db.prepare('UPDATE push_subscriptions SET last_sent_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
        sent += 1;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // 404 and 410 mean the browser threw the subscription away. Retrying forever helps nobody.
        if (status === 404 || status === 410) {
          this.deps.db.prepare('UPDATE push_subscriptions SET gone_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
          this.deps.log.info({ subscription: row.id, status }, 'a push subscription is gone; it will not be tried again');
        } else {
          this.deps.log.warn({ err: e, subscription: row.id }, 'a push notification could not be delivered');
        }
      }
    }
    return { sent, payload };
  }

  private row(id: string): Row | null {
    return (this.deps.db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  private toSummary(row: Row): PushSubscription {
    return {
      id: row.id,
      // The endpoint is a capability URL: showing it in full would put it in a screenshot. The host is enough
      // to tell one device from another.
      endpoint: safeHost(row.endpoint),
      deviceLabel: row.device_label,
      events: JSON.parse(row.events_json) as PushEventKind[],
      lastSentAt: row.last_sent_at,
      createdAt: row.created_at,
    };
  }
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}
