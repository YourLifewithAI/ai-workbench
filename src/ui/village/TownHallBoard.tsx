// The notice board outside the town hall (D-71): what needs you and what is running, on the square, so a person
// coming back sees the state of things before entering a building. The same facts the Dashboard shows, from
// the same request; RUN-20 adds what finished while you were away.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { RunningRuns } from '../components/RunningRuns.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { CardTitle, Subheading } from '../components/ui/text.js';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function TownHallBoard({ className }: { className?: string | undefined }) {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 5000 });
  const d = q.data;

  if (q.isError) return <p role="alert" className={className}>The notice board could not be read: {q.error.message}</p>;
  if (!d) return <p role="status" className={className}>Reading the notice board…</p>;

  const approvals = d.approvals.length;
  const reviews = d.needsYou.length;
  const failed = d.failed.length;
  const quiet = approvals + reviews + failed === 0 && d.running.length === 0;

  return (
    <Card className={className} data-testid="town-hall">
      <CardTitle>Town hall</CardTitle>
      {quiet ? (
        <div className="mt-3">
          <EmptyState title="Nothing needs you and nothing is running.">
            <Button asChild><Link to="/workflows">Run a workflow</Link></Button>
          </EmptyState>
        </div>
      ) : (
        <>
          {/* Sentences, not the screens' names: the twelve building links own those exact names. */}
          {approvals + reviews + failed > 0 ? (
            <ul className="mt-3 space-y-1 text-sm">
              {approvals ? <li><Link to="/dashboard" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">{plural(approvals, 'agent is', 'agents are')} waiting for your permission</Link></li> : null}
              {reviews ? <li><Link to="/review" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">{plural(reviews, 'output is', 'outputs are')} waiting for your review</Link></li> : null}
              {failed ? <li><Link to="/runs" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">{plural(failed, 'run stopped', 'runs stopped')} and could use a look</Link></li> : null}
            </ul>
          ) : null}
          {d.running.length ? (
            <>
              <Subheading className="mt-4">Running</Subheading>
              <RunningRuns runs={d.running} keys={['dashboard']} className="mt-2" />
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}
