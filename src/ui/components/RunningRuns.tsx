// Every running run, with what it has spent and a Cancel button (ui.md §UX rules: "everywhere it appears"). The
// Dashboard and the village's town hall board show the same list, so it is drawn once.
import { Link } from 'react-router-dom';
import type { RunSummary } from '../../shared/api/index.js';
import { cn } from '../lib/cn.js';
import { CANCELLABLE, CancelButton, stateTone } from '../screens/Runs.js';
import { BudgetLine } from './BudgetBar.js';
import { Badge, Card } from './ui/card.js';

export function RunningRuns({ runs, keys, className }: { runs: RunSummary[]; keys: string[]; className?: string | undefined }) {
  if (!runs.length) return null;
  return (
    <ul className={cn('space-y-2', className)}>
      {runs.map((r) => (
        <li key={r.id}>
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">
                  <Link to={`/runs/${r.id}`} className="font-medium underline-offset-4 hover:underline">{r.workflowId ?? r.agentId ?? r.id}</Link>{' '}
                  <Badge tone={stateTone(r.state)}>{r.state}</Badge>
                </p>
                <BudgetLine run={r} className="mt-2" />
              </div>
              {CANCELLABLE.has(r.state) ? <CancelButton runId={r.id} keys={keys} /> : null}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
