// The scheduler (D-15). In-process, local time zone, `croner` for the cron arithmetic only: the loop that
// decides what to fire is ours, so a test can drive it with a fake clock instead of waiting on wall time.
import { ulid } from 'ulid';
import { Cron } from 'croner';
import type { Db } from '../db/index.js';
import type { Logger } from '../log/index.js';
import type { ScheduleSummary } from '../../shared/api/index.js';
import type { LoadedWorkflow } from '../../shared/workflow.js';

export type CatchUp = 'none' | 'once';

export interface ScheduleRow {
  id: string; workflow_id: string; cron: string; inputs_json: string; project: string | null;
  enabled: number; catch_up: CatchUp; seeded_from_file: number;
  last_fired_at: string | null; next_fire_at: string | null; created_at: string;
}

export interface SchedulerDeps {
  db: Db;
  log: Logger;
  /** Starts a run. The scheduler does not care what happens next: a scheduled run is an ordinary run. */
  start: (input: { workflowId: string; inputs: Record<string, unknown>; project?: string | undefined }) => { runId: string };
  /** Injectable so a test can move time without waiting for it. */
  now?: (() => Date) | undefined;
}

export interface UpsertScheduleInput {
  workflowId: string;
  cron: string;
  inputs?: Record<string, unknown> | undefined;
  project?: string | undefined;
  enabled?: boolean | undefined;
  catchUp?: CatchUp | undefined;
}

export class ScheduleError extends Error { constructor(m: string) { super(m); this.name = 'ScheduleError'; } }

/** How often the loop wakes in production. A minute-granular cron needs a sub-minute tick to never miss one. */
const TICK_MS = 20_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ---- rows ----------------------------------------------------------------------------------------------

  /**
   * A workflow file's `schedule` block seeds a row the first time that workflow is seen and is ignored after
   * (D-15): the row is what the owner edits, and a file edit must not silently undo an edit made in the UI.
   */
  seedFromWorkflows(workflows: Iterable<LoadedWorkflow>): number {
    let seeded = 0;
    for (const workflow of workflows) {
      const schedule = workflow.definition.schedule;
      if (!schedule) continue;
      const existing = this.deps.db.prepare('SELECT id FROM schedules WHERE workflow_id = ? AND seeded_from_file = 1').get(workflow.definition.id);
      if (existing) continue;
      this.upsert({
        workflowId: workflow.definition.id, cron: schedule.cron, inputs: schedule.inputs,
        catchUp: schedule.catchUp, enabled: schedule.enabled, ...(workflow.definition.defaultProject ? { project: workflow.definition.defaultProject } : {}),
      }, true);
      seeded += 1;
    }
    if (seeded) this.deps.log.info({ seeded }, 'schedules seeded from workflow files');
    return seeded;
  }

  upsert(input: UpsertScheduleInput, fromFile = false, id?: string): ScheduleSummary {
    const next = nextRun(input.cron, this.now());
    if (!next) throw new ScheduleError(`"${input.cron}" is not a cron expression this scheduler can read. Five fields, minute first: "0 7 * * *" is every day at 07:00.`);
    const now = this.now().toISOString();
    const existing = id ? this.row(id) : null;
    if (id && !existing) throw new ScheduleError(`There is no schedule with id "${id}".`);

    const row: ScheduleRow = {
      id: existing?.id ?? ulid(),
      workflow_id: input.workflowId,
      cron: input.cron,
      inputs_json: JSON.stringify(input.inputs ?? {}),
      project: input.project ?? existing?.project ?? null,
      enabled: (input.enabled ?? (existing ? existing.enabled === 1 : true)) ? 1 : 0,
      catch_up: input.catchUp ?? existing?.catch_up ?? 'none',
      seeded_from_file: existing?.seeded_from_file ?? (fromFile ? 1 : 0),
      last_fired_at: existing?.last_fired_at ?? null,
      next_fire_at: next.toISOString(),
      created_at: existing?.created_at ?? now,
    };
    this.deps.db.prepare(`INSERT INTO schedules (id, workflow_id, cron, inputs_json, project, enabled, catch_up, seeded_from_file, last_fired_at, next_fire_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET workflow_id = excluded.workflow_id, cron = excluded.cron, inputs_json = excluded.inputs_json,
        project = excluded.project, enabled = excluded.enabled, catch_up = excluded.catch_up, next_fire_at = excluded.next_fire_at`)
      .run(row.id, row.workflow_id, row.cron, row.inputs_json, row.project, row.enabled, row.catch_up, row.seeded_from_file, row.last_fired_at, row.next_fire_at, row.created_at);
    return toSummary(this.row(row.id)!);
  }

  remove(id: string): boolean {
    return this.deps.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }

  list(): ScheduleSummary[] {
    const rows = this.deps.db.prepare('SELECT * FROM schedules ORDER BY next_fire_at').all() as ScheduleRow[];
    return rows.map(toSummary);
  }

  private row(id: string): ScheduleRow | null {
    return (this.deps.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined) ?? null;
  }

  // ---- the loop ------------------------------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        this.deps.log.error({ err: e }, 'the scheduler tick failed');
      }
    }, TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. A schedule whose time has come fires once and is advanced past *now*, so an outage never fires a
   * backlog: `catchUp: 'once'` is one run for everything missed, `'none'` is none (D-15).
   */
  tick(): { fired: { scheduleId: string; runId: string }[]; skipped: string[] } {
    const now = this.now();
    const due = this.deps.db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?')
      .all(now.toISOString()) as ScheduleRow[];

    const fired: { scheduleId: string; runId: string }[] = [];
    const skipped: string[] = [];
    for (const row of due) {
      const missed = this.missedWindows(row, now);
      const advanced = nextRun(row.cron, now);
      if (missed > 1 && row.catch_up === 'none') {
        this.deps.log.info({ schedule: row.id, missed }, 'skipping missed windows: catchUp is none');
        skipped.push(row.id);
        this.deps.db.prepare('UPDATE schedules SET next_fire_at = ?, last_fired_at = ? WHERE id = ?')
          .run(advanced?.toISOString() ?? null, now.toISOString(), row.id);
        continue;
      }
      try {
        const { runId } = this.deps.start({
          workflowId: row.workflow_id,
          inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
          ...(row.project ? { project: row.project } : {}),
        });
        fired.push({ scheduleId: row.id, runId });
        this.deps.log.info({ schedule: row.id, workflow: row.workflow_id, runId, missed }, 'scheduled run started');
      } catch (e) {
        // A schedule pointing at a workflow that no longer loads must not stop the other schedules.
        this.deps.log.error({ err: e, schedule: row.id, workflow: row.workflow_id }, 'a scheduled run could not start');
        skipped.push(row.id);
      }
      this.deps.db.prepare('UPDATE schedules SET last_fired_at = ?, next_fire_at = ? WHERE id = ?')
        .run(now.toISOString(), advanced?.toISOString() ?? null, row.id);
    }
    return { fired, skipped };
  }

  /** How many of this schedule's windows have passed since it was last due — 1 is on time, more is an outage. */
  private missedWindows(row: ScheduleRow, now: Date): number {
    const from = row.next_fire_at ? new Date(row.next_fire_at) : now;
    let count = 0;
    let cursor = from;
    // Bounded: nobody needs to know whether an outage missed 500 windows or 5,000.
    while (cursor <= now && count < 500) {
      count += 1;
      const next = nextRun(row.cron, cursor);
      if (!next || next <= cursor) break;
      cursor = next;
    }
    return count;
  }
}

/** `null` when the expression is not one croner can read, which is how `upsert` rejects a bad cron. */
export function nextRun(expression: string, from: Date): Date | null {
  try {
    return new Cron(expression, { paused: true }).nextRun(from);
  } catch {
    return null;
  }
}

function toSummary(row: ScheduleRow): ScheduleSummary {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    cron: row.cron,
    inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
    project: row.project,
    enabled: row.enabled === 1,
    catchUp: row.catch_up,
    seededFromFile: row.seeded_from_file === 1,
    lastFiredAt: row.last_fired_at,
    nextFireAt: row.next_fire_at,
  };
}
