// Every other agent as a card beneath the orchestrator (D-79): what it has been doing lately, what it has spent,
// and how it was rated — the orchestrator's estimate and the owner's own as two numbers that say whose they are.
// Selecting a card opens it onto the agent's last runs; nothing here costs a model call.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { AgentReport, RatingAggregate } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { heartbeatLine, money, spentLine } from '../lib/agentLines.js';
import { stateTone } from '../screens/Runs.js';
import { Button } from './ui/button.js';
import { Badge, Card } from './ui/card.js';
import { CardTitle, Hint } from './ui/text.js';

const STATE_TONE: Record<AgentReport['state'], 'neutral' | 'good' | 'bad' | 'busy'> = { running: 'busy', waiting: 'bad', failed: 'bad', idle: 'good', never: 'neutral' };
const STATE_WORD: Record<AgentReport['state'], string> = { running: 'working', waiting: 'needs you', failed: 'last run failed', idle: 'idle', never: 'has not run yet' };

export function AgentCards({ agents }: { agents: AgentReport[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (agents.length === 0) return <Hint className="mt-2">No other agents in this workspace.</Hint>;
  return (
    <ul className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="agent-cards">
      {agents.map((r) => (
        <li key={r.agent.id} className={selected === r.agent.id ? 'sm:col-span-2 xl:col-span-3' : ''}>
          <AgentCard report={r} open={selected === r.agent.id} onToggle={() => setSelected((s) => (s === r.agent.id ? null : r.agent.id))} />
        </li>
      ))}
    </ul>
  );
}

function AgentCard({ report: r, open, onToggle }: { report: AgentReport; open: boolean; onToggle: () => void }) {
  const a = r.agent;
  const w = r.window;
  return (
    <Card data-testid={`agent-card-${a.id}`} className={open ? 'border-blue-700 dark:border-sky-400' : ''}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The heading is the name alone; the state chip sits beside it, so "needs you" is a badge, not a title. */}
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h3"><Link to={`/agents/${a.id}`} className="underline-offset-4 hover:underline">{a.name}</Link></CardTitle>
            <Badge tone={STATE_TONE[r.state]}>{STATE_WORD[r.state]}</Badge>
          </div>
          <Hint className="mt-1">{a.description}</Hint>
        </div>
        <Button size="sm" variant="secondary" aria-expanded={open} onClick={onToggle}>
          {open ? 'Close' : 'Details'}<span className="sr-only"> for {a.name}</span>
        </Button>
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex gap-2" data-testid={`card-lately-${a.id}`}>
          <dt className="w-14 shrink-0 text-gray-600 dark:text-gray-400">Lately</dt>
          <dd className="min-w-0">
            {w.runs + w.steps === 0 ? 'nothing this week' : `${w.runs} run${w.runs === 1 ? '' : 's'}${w.steps ? `, ${w.steps} step${w.steps === 1 ? '' : 's'} in workflows` : ''}${w.failed ? `, ${w.failed} failed` : ''}${w.running ? `, ${w.running} running` : ''}`}
            {r.latest ? <span className="block truncate text-xs text-gray-600 dark:text-gray-400" title={r.latest.summary.join(' ')}>{r.latest.summary[0]}</span> : null}
          </dd>
        </div>
        {a.spend ? (
          <div className="flex gap-2" data-testid={`card-spent-${a.id}`}><dt className="w-14 shrink-0 text-gray-600 dark:text-gray-400">Spent</dt><dd className="font-mono text-xs">{spentLine(a.spend)}</dd></div>
        ) : null}
        <div className="flex gap-2" data-testid={`card-rated-${a.id}`}>
          <dt className="w-14 shrink-0 text-gray-600 dark:text-gray-400">Rated</dt>
          <dd className="min-w-0">
            <span>{ratingWords('orchestrator', r.ratings.orchestrator)} · {ratingWords('you', r.ratings.owner)}</span>
            {r.ratings.orchestrator.latestWhy ? <span className="block truncate text-xs text-gray-600 dark:text-gray-400" title={r.ratings.orchestrator.latestWhy}>“{r.ratings.orchestrator.latestWhy}”</span> : null}
          </dd>
        </div>
        {a.heartbeat ? (
          <div className="flex gap-2"><dt className="w-14 shrink-0 text-gray-600 dark:text-gray-400">Pulse</dt><dd className="text-xs">{heartbeatLine(a.heartbeat)}</dd></div>
        ) : null}
      </dl>
      {open ? <Details report={r} /> : null}
    </Card>
  );
}

/** "orchestrator 3.5 over 4" / "you 4.0 over 2" / "you: none yet": a number always says whose it is (D-36, D-50). */
function ratingWords(whose: string, agg: RatingAggregate): string {
  if (agg.count === 0) return `${whose}: none yet`;
  return `${whose} ${agg.mean?.toFixed(1)} over ${agg.count}`;
}

function Details({ report: r }: { report: AgentReport }) {
  const runs = useQuery({ queryKey: ['runs-for', r.agent.id], queryFn: () => api.runsFor(r.agent.id, 10) });
  return (
    <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800" data-testid={`agent-details-${r.agent.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Last runs</p>
        <div className="flex gap-2">
          {r.needsYou.reviews + r.needsYou.approvals + r.needsYou.decisions > 0 ? (
            <Badge tone="bad">{r.needsYou.reviews ? `${r.needsYou.reviews} for review` : r.needsYou.approvals ? `${r.needsYou.approvals} asking permission` : `${r.needsYou.decisions} asked you`}</Badge>
          ) : null}
          <Link to={`/agents/${r.agent.id}`} className="inline-block py-1 text-sm text-blue-700 underline underline-offset-4 dark:text-sky-300">Run it</Link>
        </div>
      </div>
      {runs.isPending ? <Hint className="mt-2">Loading…</Hint> : null}
      {runs.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{runs.error.message}</p> : null}
      {runs.data?.length === 0 ? <Hint className="mt-2">It has not run yet.</Hint> : null}
      {runs.data?.length ? (
        <ul className="mt-2 divide-y divide-gray-200 text-sm dark:divide-gray-800">
          {runs.data.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <Badge tone={stateTone(run.state)}>{run.state}</Badge>
              <span className="text-gray-700 dark:text-gray-300">{new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              <span className="font-mono text-xs">{money(run.spent.costUsd)}</span>
              {run.project ? <span className="text-xs text-gray-600 dark:text-gray-400">{run.project}</span> : null}
              <Link to={`/runs/${run.id}`} className="ml-auto inline-block py-1 text-blue-700 underline underline-offset-4 dark:text-sky-300">trace</Link>
            </li>
          ))}
        </ul>
      ) : null}
      {r.latest ? (
        <ul className="mt-3 space-y-0.5 text-xs text-gray-600 dark:text-gray-400">
          {r.latest.summary.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
