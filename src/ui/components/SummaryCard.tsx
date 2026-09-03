// The summary layer (D-58): three lines above the raw timeline, so a failure is legible without reading events.
import type { Summary } from '../../shared/summary.js';
import { cn } from '../lib/cn.js';

const TONE: Record<Summary['tone'], string> = {
  good: 'border-l-green-600 dark:border-l-green-400',
  bad: 'border-l-red-600 dark:border-l-red-400',
  busy: 'border-l-amber-600 dark:border-l-amber-400',
  neutral: 'border-l-gray-400 dark:border-l-gray-600',
};

export function SummaryCard({ summary, className }: { summary: Summary; className?: string }) {
  return (
    <section aria-label="Summary" className={cn('rounded-lg border border-l-4 border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900', TONE[summary.tone], className)}>
      <p className="font-medium">{summary.headline}</p>
      <ul className="mt-1 space-y-0.5 text-sm text-gray-700 dark:text-gray-300">
        {summary.lines.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </section>
  );
}
