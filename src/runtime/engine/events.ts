// Append-only event store with a live bus for SSE (spec/data-model.md). Payloads are redacted on write (D-33).
import { EventEmitter } from 'node:events';
import type { Db } from '../db/index.js';
import type { Redactor } from '../security/redaction.js';
import type { EventRecord, EventType } from '../../shared/events.js';

export const EVENT_SCHEMA_V = 1;
export const TERMINAL_EVENTS: ReadonlySet<EventType> = new Set(['run-completed', 'run-failed', 'run-cancelled', 'run-interrupted']);

export class EventStore {
  private readonly bus = new EventEmitter();
  private readonly insert;
  private readonly selectAfter;

  constructor(private readonly db: Db, private readonly redactor: Redactor) {
    this.bus.setMaxListeners(1000);
    this.insert = db.prepare('INSERT INTO events (run_id, step_id, type, payload_json, schema_v, ts) VALUES (?, ?, ?, ?, ?, ?)');
    this.selectAfter = db.prepare('SELECT seq, run_id, step_id, type, payload_json, schema_v, ts FROM events WHERE run_id = ? AND seq > ? ORDER BY seq');
  }

  append(runId: string, stepId: string | null, type: EventType, payload: Record<string, unknown>): EventRecord {
    const ts = new Date().toISOString();
    const redacted = this.redactor.redact(payload);
    const info = this.insert.run(runId, stepId, type, JSON.stringify(redacted), EVENT_SCHEMA_V, ts);
    const record: EventRecord = { seq: Number(info.lastInsertRowid), runId, stepId, type, ts, schemaVersion: EVENT_SCHEMA_V, payload: redacted };
    this.bus.emit('event', record);
    return record;
  }

  list(runId: string, afterSeq = 0): EventRecord[] {
    const rows = this.selectAfter.all(runId, afterSeq) as { seq: number; run_id: string; step_id: string | null; type: EventType; payload_json: string; schema_v: number; ts: string }[];
    return rows.map((r) => ({ seq: r.seq, runId: r.run_id, stepId: r.step_id, type: r.type, ts: r.ts, schemaVersion: r.schema_v, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
  }

  subscribe(listener: (e: EventRecord) => void): () => void {
    this.bus.on('event', listener);
    return () => this.bus.off('event', listener);
  }

  get database(): Db { return this.db; }
}
