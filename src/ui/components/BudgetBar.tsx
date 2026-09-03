// What a run has spent against what it may spend (D-14). Three bars, because one number hides which one bites.
import type { RunSummary } from '../../shared/api/index.js';
import { money, seconds } from '../../shared/summary.js';
import { cn } from '../lib/cn.js';

interface Line { label: string; used: number; limit: number; text: string }

function linesFor(run: RunSummary): Line[] {
  return [
    { label: 'Model calls', used: run.spent.modelCalls, limit: run.budgets.maxModelCalls, text: `${run.spent.modelCalls} of ${run.budgets.maxModelCalls}` },
    { label: 'Cost', used: run.spent.costUsd, limit: run.budgets.maxCostUsd, text: `${money(run.spent.costUsd)} of ${money(run.budgets.maxCostUsd)}` },
    { label: 'Time', used: run.spent.wallClockMs, limit: run.budgets.maxWallClockMs, text: `${seconds(run.spent.wallClockMs)} of ${seconds(run.budgets.maxWallClockMs)}` },
  ];
}

const fractionOf = (line: Line): number => (line.limit > 0 ? Math.min(1, line.used / line.limit) : 0);

/**
 * One line for a table row: the numbers, and a bar for whichever budget is closest to its limit — that is the
 * one that will end the run, and three bars in a table cell say less than one that points at the right thing.
 */
export function BudgetLine({ run, className }: { run: RunSummary; className?: string }) {
  const lines = linesFor(run);
  const tightest = lines.reduce((worst, line) => (fractionOf(line) > fractionOf(worst) ? line : worst), lines[0]!);
  const fraction = fractionOf(tightest);
  const near = fraction >= 0.8;

  return (
    <div className={className}>
      <p className="text-xs tabular-nums text-gray-700 dark:text-gray-300">
        {lines.map((l) => l.text).join(' · ')}
      </p>
      <div
        role="meter"
        aria-label={`Tightest budget: ${tightest.label}`}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${tightest.label}, ${tightest.text}`}
        className="mt-1 h-1.5 w-full max-w-56 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
      >
        <div className={cn('h-full rounded-full', near ? 'bg-amber-600 dark:bg-amber-400' : 'bg-blue-700 dark:bg-sky-400')} style={{ width: `${Math.max(fraction * 100, fraction > 0 ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}

export function BudgetBar({ run, className }: { run: RunSummary; className?: string }) {
  const lines = linesFor(run);

  return (
    <dl className={cn('grid gap-3 sm:grid-cols-3', className)} aria-label="Budget">
      {lines.map((line) => {
        const fraction = fractionOf(line);
        const near = fraction >= 0.8;
        return (
          // A `dl` may only hold dt/dd (optionally wrapped one level in a div), so the bar lives in a second dd
          // rather than a sibling of the pair — axe's `dlitem` rule is right about this.
          <div key={line.label} className="flex flex-wrap items-baseline justify-between gap-x-2">
            <dt className="text-xs font-medium text-gray-700 dark:text-gray-300">{line.label}</dt>
            <dd className="text-xs tabular-nums text-gray-700 dark:text-gray-300">{line.text}</dd>
            <dd className="mt-1 w-full">
              {/* The meter is a div inside the dd: a role on the dd itself stops it counting as a definition. */}
              <div
                role="meter"
                aria-label={`${line.label} budget`}
                aria-valuenow={Math.round(fraction * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={line.text}
                className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
              >
                <div className={cn('h-full rounded-full', near ? 'bg-amber-600 dark:bg-amber-400' : 'bg-blue-700 dark:bg-sky-400')} style={{ width: `${Math.max(fraction * 100, fraction > 0 ? 2 : 0)}%` }} />
              </div>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
