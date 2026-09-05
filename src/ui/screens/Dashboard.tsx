// What needs you, what is running, and what today cost (ui.md §Dashboard). One request, in that order: the
// point of this screen is that a person coming back after a day can see the state of things without reading.
import { useEffect, useState } from 'react';
import { describeCron } from '../lib/cron';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { money } from '../../shared/summary.js';
import type { DashboardResponse } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { ApprovalCard } from '../components/ApprovalCard.js';
import { BudgetLine } from '../components/BudgetBar.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';
import { CANCELLABLE, stateTone, useLiveRuns } from './Runs.js';

export function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 5000 });
  useLiveRuns(['dashboard']);
  const client = useQueryClient();
  const navigate = useNavigate();
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelRun(id), onSuccess: () => client.invalidateQueries({ queryKey: ['dashboard'] }) });
  const resume = useMutation({ mutationFn: (id: string) => api.resumeRun(id), onSuccess: () => client.invalidateQueries({ queryKey: ['dashboard'] }) });
  const offline = useMutation({ mutationFn: () => api.setNetworkMode('offline'), onSuccess: () => client.invalidateQueries() });
  const decide = useMutation({
    mutationFn: (input: { batchId: string; decision: 'allow' | 'deny' }) => api.decideApproval(input.batchId, input.decision),
    onSuccess: () => client.invalidateQueries({ queryKey: ['dashboard'] }),
  });

  const d = q.data;
  const [cursor, setCursor] = useState(0);
  const pending = d?.approvals ?? [];
  const focused = pending[Math.min(cursor, Math.max(0, pending.length - 1))];

  // `a` allows and `d` denies the focused approval, `j`/`k` move between them (D-57, D-59). Nothing here is
  // modal: the same decisions are buttons on the card and commands in `workbench approvals`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey || !focused) return;
      if (e.key === 'j') { setCursor((c) => Math.min(pending.length - 1, c + 1)); e.preventDefault(); return; }
      if (e.key === 'k') { setCursor((c) => Math.max(0, c - 1)); e.preventDefault(); return; }
      if (e.key === 'a') { decide.mutate({ batchId: focused.batchId, decision: 'allow' }); e.preventDefault(); return; }
      if (e.key === 'd') { decide.mutate({ batchId: focused.batchId, decision: 'deny' }); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, pending.length, decide]);
  const capFraction = d && d.dailySpendCapUsd > 0 ? Math.min(1, d.spentTodayUsd / d.dailySpendCapUsd) : 0;
  const monthFraction = d && d.monthlySpendCapUsd > 0 ? Math.min(1, d.spentThisMonthUsd / d.monthlySpendCapUsd) : 0;

  return (
    <section aria-labelledby="screen-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 id="screen-title" className="text-2xl font-semibold">Dashboard</h1>
        {d && d.networkMode !== 'offline' ? (
          <Button variant="secondary" size="sm" onClick={() => offline.mutate()} disabled={offline.isPending}>
            {offline.isPending ? 'Going offline…' : 'Pause all — go offline'}
          </Button>
        ) : null}
      </div>

      {q.isPending ? <p className="mt-4" role="status">Loading…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load the dashboard: {q.error.message}</p> : null}

      {d ? (
        <>
          <h2 className="mt-6 text-lg font-medium">Needs you</h2>
          {pending.length ? (
            <p className="mt-1 hidden text-sm text-gray-600 md:block dark:text-gray-400">
              Keys: <kbd className="font-mono">a</kbd> allow · <kbd className="font-mono">d</kbd> deny · <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> move.
            </p>
          ) : null}
          {d.approvals.length === 0 && d.needsYou.length === 0 && d.failed.length === 0 ? (
            <div className="mt-2">
              <EmptyState title={waitingTitle(d)}>
                {d.unreviewed > 0 || d.findings > 0 ? <Button onClick={() => navigate('/review')}>Open Review</Button> : null}
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-2 space-y-2">
              {/* Approvals first: a review waits as long as you like, an approval is refused on a timer. */}
              {d.approvals.map((a) => (
                <li key={a.batchId}><ApprovalCard item={a} focused={a.batchId === focused?.batchId} /></li>
              ))}
              {d.needsYou.map((r) => (
                <li key={r.id}>
                  <Card className="border-l-4 border-l-amber-600 dark:border-l-amber-400">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm">
                        <strong>{r.subject}</strong> is standing still: step <span className="font-mono text-xs">{r.stepId}</span> is waiting for your review
                        {r.attempt > 1 ? ` (attempt ${r.attempt})` : ''}.
                      </p>
                      <Button size="sm" onClick={() => navigate('/review')}>Review it</Button>
                    </div>
                  </Card>
                </li>
              ))}
              {d.failed.map((r) => (
                <li key={r.id}>
                  <Card className="border-l-4 border-l-red-600 dark:border-l-red-400">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm">
                        <Link to={`/runs/${r.id}`} className="underline underline-offset-4">{r.workflowId ?? r.agentId ?? r.id}</Link> {r.state === 'interrupted' ? 'was interrupted by a restart' : 'failed'}.
                      </p>
                      <Button size="sm" variant="secondary" onClick={() => resume.mutate(r.id)} disabled={resume.isPending}>
                        Resume<span className="sr-only"> run {r.id}</span>
                      </Button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          {/* The permissions review's open findings (F8): counted here, decided in Review, blocking nothing. */}
          {d.findings > 0 ? (
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300" data-testid="findings-count">
              <Link to="/review" className="underline underline-offset-4">{d.findings} permission finding{d.findings === 1 ? '' : 's'}</Link>
              {' '}from the review {d.findings === 1 ? 'is' : 'are'} waiting in Review.
            </p>
          ) : null}
          {resume.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{resume.error.message}</p> : null}

          <h2 className="mt-8 text-lg font-medium">Running</h2>
          {d.running.length === 0 ? (
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">Nothing is running.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {d.running.map((r) => (
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
                      {CANCELLABLE.has(r.state) ? (
                        <Button size="sm" variant="secondary" onClick={() => cancel.mutate(r.id)} disabled={cancel.isPending}>
                          Cancel<span className="sr-only"> run {r.id}</span>
                        </Button>
                      ) : null}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mt-8 text-lg font-medium">Today and this month</h2>
          <Card className="mt-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm">Spent today</p>
              <p className="text-sm tabular-nums">{money(d.spentTodayUsd)} of {money(d.dailySpendCapUsd)}</p>
            </div>
            <div
              role="meter"
              aria-label="Daily spending cap"
              aria-valuenow={Math.round(capFraction * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={`${money(d.spentTodayUsd)} of ${money(d.dailySpendCapUsd)}`}
              className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
            >
              <div className={capFraction >= 0.8 ? 'h-full rounded-full bg-amber-600 dark:bg-amber-400' : 'h-full rounded-full bg-blue-700 dark:bg-sky-400'} style={{ width: `${Math.max(capFraction * 100, capFraction > 0 ? 2 : 0)}%` }} />
            </div>
            <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2" data-testid="month-spend">
              <p className="text-sm">This month</p>
              <p className="text-sm tabular-nums">
                {money(d.spentThisMonthUsd)}{d.monthlySpendCapUsd > 0 ? ` of ${money(d.monthlySpendCapUsd)}` : ''} · heading for {money(d.projectedMonthUsd)}
              </p>
            </div>
            {d.monthlySpendCapUsd > 0 ? (
              <div
                role="meter"
                aria-label="Monthly spending cap"
                aria-valuenow={Math.round(monthFraction * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={`${money(d.spentThisMonthUsd)} of ${money(d.monthlySpendCapUsd)}`}
                className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
              >
                <div className={monthFraction >= 0.8 ? 'h-full rounded-full bg-amber-600 dark:bg-amber-400' : 'h-full rounded-full bg-blue-700 dark:bg-sky-400'} style={{ width: `${Math.max(monthFraction * 100, monthFraction > 0 ? 2 : 0)}%` }} />
              </div>
            ) : null}
            {d.schedulesPaused ? (
              <p role="alert" className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                Schedules are paused: the month&apos;s cap is used up. Raise it in <Link to="/settings" className="underline underline-offset-4">Settings</Link>, or wait for the month to turn.
              </p>
            ) : null}
            <h3 className="mt-4 text-sm font-medium">Next scheduled</h3>
            {d.schedules.length === 0 ? (
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                Nothing is scheduled. Add one from a <Link to="/workflows" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">workflow</Link>.
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {d.schedules.map((s) => (
                  <li key={s.id} className="flex flex-wrap gap-2">
                    <Link to={`/workflows/${s.workflowId}`} className="underline-offset-4 hover:underline">{s.workflowId}</Link>
                    <span className="text-gray-700 dark:text-gray-300" title={s.cron}>{describeCron(s.cron)}</span>
                    <span className="text-gray-700 dark:text-gray-300">{s.nextFireAt ? new Date(s.nextFireAt).toLocaleString() : 'never'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </section>
  );
}

/** The empty state under Needs you: honest about what waits without blocking (ratings, the review's findings). */
function waitingTitle(d: DashboardResponse): string {
  if (d.unreviewed > 0) return `Nothing is blocked. ${d.unreviewed} output${d.unreviewed === 1 ? '' : 's'} would like a rating when you have a moment.`;
  if (d.findings > 0) return 'Nothing is blocked.';
  return 'Nothing is waiting on you.';
}
