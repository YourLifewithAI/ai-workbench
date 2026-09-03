// Budgets (D-14). A run carries its own counters, warns once per budget at 80%, and gives the agent one
// wrap-up turn when model calls run out — so a bounded run ends with a summary rather than a truncation.
import type { Budgets } from '../../shared/permissions.js';
import type { Spent } from '../../shared/events.js';

/** A partial that tolerates an explicitly-undefined key, which is what Zod's `.partial()` produces. */
export type BudgetOverride = { [K in keyof Budgets]?: number | undefined };

export type BudgetKind = 'maxModelCalls' | 'maxToolCalls' | 'maxCostUsd' | 'maxWallClockMs';

export interface BudgetStop {
  reason: 'budget_exceeded' | 'wall_clock_exceeded' | 'daily_cap_reached';
  budget: BudgetKind | 'dailySpendCapUsd';
  message: string;
  /** Soft budgets end with a wrap-up turn; wall clock and the daily cap are hard stops (D-14). */
  allowWrapUp: boolean;
}

const WARN_AT = 0.8;

export class RunBudget {
  readonly spent: Spent = { modelCalls: 0, toolCalls: 0, costUsd: 0, wallClockMs: 0 };
  private readonly warned = new Set<BudgetKind>();
  private wrapUpUsed = false;

  constructor(
    readonly limits: Budgets,
    private readonly startedMs: number,
    /** What the whole workspace has already spent today, for the daily cap. */
    private readonly spentTodayUsd: () => number,
    /**
     * A step budget narrows the run's without escaping it: spending is recorded in both, and the run's limits
     * still stop the step even when the step's own are untouched (D-20).
     */
    private readonly parent?: RunBudget | undefined,
  ) {}

  /** A budget for one step: its own limits, never wider than this one's, spending counted in both. */
  child(override: BudgetOverride | undefined): RunBudget {
    if (!override) return this;
    return new RunBudget(narrowBudgets(this.limits, override), this.startedMs, this.spentTodayUsd, this);
  }

  get wallClockMs(): number {
    return Date.now() - this.startedMs;
  }

  snapshot(): Spent {
    return { ...this.spent, wallClockMs: this.wallClockMs };
  }

  recordModelCall(costUsd: number): void {
    this.spent.modelCalls += 1;
    this.spent.costUsd = round(this.spent.costUsd + costUsd);
    this.parent?.recordModelCall(costUsd);
  }

  recordToolCall(): void {
    this.spent.toolCalls += 1;
    this.parent?.recordToolCall();
  }

  /** Budgets that just crossed 80% and have not been warned about yet. Each warns once (D-14). */
  newWarnings(): { budget: BudgetKind; used: number; limit: number }[] {
    const checks: { budget: BudgetKind; used: number; limit: number }[] = [
      { budget: 'maxModelCalls', used: this.spent.modelCalls, limit: this.limits.maxModelCalls },
      { budget: 'maxToolCalls', used: this.spent.toolCalls, limit: this.limits.maxToolCalls },
      { budget: 'maxCostUsd', used: this.spent.costUsd, limit: this.limits.maxCostUsd },
    ];
    const out: { budget: BudgetKind; used: number; limit: number }[] = [];
    for (const check of checks) {
      if (check.limit <= 0 || this.warned.has(check.budget)) continue;
      if (check.used >= check.limit * WARN_AT) {
        this.warned.add(check.budget);
        out.push(check);
      }
    }
    return out;
  }

  hasWarned(budget: BudgetKind): boolean {
    return this.warned.has(budget);
  }

  /** Checked before every model call. `null` means the call may proceed. */
  checkBeforeModelCall(): BudgetStop | null {
    const fromParent = this.parent?.checkBeforeModelCall();
    if (fromParent) return fromParent;
    if (this.wallClockMs >= this.limits.maxWallClockMs) {
      return { reason: 'wall_clock_exceeded', budget: 'maxWallClockMs', allowWrapUp: false, message: `This run reached its time limit (${Math.round(this.limits.maxWallClockMs / 1000)}s). Nothing further was sent. Raise maxWallClockMs in Settings, or split the work into smaller runs.` };
    }
    const today = this.spentTodayUsd();
    if (this.limits.dailySpendCapUsd > 0 && today >= this.limits.dailySpendCapUsd) {
      return { reason: 'daily_cap_reached', budget: 'dailySpendCapUsd', allowWrapUp: false, message: `Today's spending cap ($${this.limits.dailySpendCapUsd.toFixed(2)}) is already used up ($${today.toFixed(2)} so far). Raise dailySpendCapUsd in Settings, or wait until tomorrow.` };
    }
    if (this.spent.costUsd >= this.limits.maxCostUsd) {
      return { reason: 'budget_exceeded', budget: 'maxCostUsd', allowWrapUp: true, message: `This run reached its cost budget ($${this.limits.maxCostUsd.toFixed(2)}).` };
    }
    // One call is held back so a bounded run can still say what it produced: with a budget of six, five calls do
    // the work and the sixth is the wrap-up. Cost cannot be reserved this way — a call's price is not known
    // until it returns — so the wrap-up after a cost stop may carry the total slightly past the limit.
    const productive = this.wrapUpUsed ? this.limits.maxModelCalls : Math.max(0, this.limits.maxModelCalls - 1);
    if (this.spent.modelCalls >= productive) {
      return { reason: 'budget_exceeded', budget: 'maxModelCalls', allowWrapUp: true, message: `This run reached its model-call budget (${this.limits.maxModelCalls} calls).` };
    }
    return null;
  }

  /** The last permitted call: tools removed, an instruction to summarise. Offered once per run. */
  takeWrapUp(): boolean {
    if (this.wrapUpUsed) return false;
    if (this.parent && !this.parent.takeWrapUp()) return false;
    this.wrapUpUsed = true;
    return true;
  }

  /** The line the harness shows the agent, so it can pace itself (agent-runtime-contract.md). */
  remainingLine(): string {
    const calls = Math.max(0, this.limits.maxModelCalls - this.spent.modelCalls);
    const dollars = Math.max(0, this.limits.maxCostUsd - this.spent.costUsd);
    const ms = Math.max(0, this.limits.maxWallClockMs - this.wallClockMs);
    const warned = this.warned.size > 0 ? ' You are past 80% of a budget.' : ' You will be warned at 80%.';
    return `Budget remaining: ${calls} model calls · $${dollars.toFixed(2)} · ${formatDuration(ms)}.${warned}`;
  }
}

export const WRAP_UP_INSTRUCTION =
  'This is your last turn: the run has reached its budget. Do not start anything new and do not call tools. ' +
  'Summarise what you have produced so far and what remains undone, so a human can pick it up.';

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** Narrowing only: a step or run may lower a budget, never raise it above the workspace's (D-20). */
export function narrowBudgets(base: Budgets, override: BudgetOverride | undefined): Budgets {
  if (!override) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override) as [keyof Budgets, number | undefined][]) {
    if (typeof value === 'number' && value < out[key]) out[key] = value;
  }
  return out;
}
