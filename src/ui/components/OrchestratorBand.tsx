// The orchestrator's band across the top of the board (D-77, D-79): who it is and what it has cost, what happened
// since the owner was last here, whatever the board says needs him (passed in), the thread, and the composer.
// Every exchange is an ordinary run; posting a message starts it and the one follower streams the reply back.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { AgentReport, ThreadEntry, ThreadHeader } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { heartbeatLine, money, spentLine } from '../lib/agentLines.js';
import { useRunStream } from '../lib/useRunStream.js';
import { DecisionCard, WorkRow } from './DecisionCard.js';
import { Button } from './ui/button.js';
import { Badge } from './ui/card.js';
import { CardTitle, Hint, Subheading } from './ui/text.js';

const STATE_TONE: Record<AgentReport['state'], 'neutral' | 'good' | 'bad' | 'busy'> = { running: 'busy', waiting: 'bad', failed: 'bad', idle: 'good', never: 'neutral' };
const STATE_WORD: Record<AgentReport['state'], string> = { running: 'working', waiting: 'needs you', failed: 'last run failed', idle: 'idle', never: 'has not run yet' };

export function OrchestratorBand({ report, children }: { report: AgentReport | null; children?: ReactNode }) {
  const client = useQueryClient();
  const latest = useQuery({ queryKey: ['conversation-latest'], queryFn: () => api.conversationLatest(), staleTime: 60_000 });
  const id = latest.data?.id ?? null;
  const thread = useQuery({ queryKey: ['conversation', id], queryFn: () => api.conversation(id!), enabled: id !== null });

  // "Since you were last here" is fixed for this visit: held from the first load, then the room is marked read.
  // Later refetches bring new entries, not a new header — that one waits for the next visit.
  const [header, setHeader] = useState<ThreadHeader | null>(null);
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!thread.data || header) return;
    setHeader(thread.data.header);
    if (marked.current !== thread.data.conversation.id) {
      marked.current = thread.data.conversation.id;
      void api.markRead(thread.data.conversation.id);
    }
  }, [thread.data, header]);

  const [draft, setDraft] = useState('');
  // Two states, because a message is a run and the thread lists a run from the moment it starts: `posted` is
  // the gap between the 202 and the thread having the exchange; `following` is the run whose reply is arriving.
  const [posted, setPosted] = useState<{ runId: string; you: string } | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const post = useMutation({
    mutationFn: (message: string) => api.postMessage(id!, message),
    onSuccess: ({ runId }, message) => { setPosted({ runId, you: message }); setFollowing(runId); setDraft(''); },
  });
  const stream = useRunStream(following, ['conversation', 'fleet', 'dashboard']);
  const answer = useMutation({
    mutationFn: (input: { id: string; answer: string }) => api.updateWork(input.id, { answer: input.answer }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['conversation'] }); void client.invalidateQueries({ queryKey: ['dashboard'] }); },
  });

  const entries = thread.data?.entries ?? [];
  // What has streamed so far stays on the entry until its reply is written, so nothing blinks between the two.
  const shown = useRef('');
  const streamed = Object.values(stream.streaming).join('');
  if (streamed) shown.current = streamed;
  useEffect(() => {
    if (posted && entries.some((e) => e.kind !== 'decision' && e.runId === posted.runId)) setPosted(null);
  }, [posted, entries]);
  useEffect(() => {
    if (!following) { shown.current = ''; return; }
    const entry = entries.find((e) => e.kind === 'exchange' && e.runId === following);
    // Done when the thread says so; and if the follower itself fails, the composer is given back — the run
    // goes on without it, and the thread refreshes from the live run events anyway.
    if (stream.error || (entry && entry.kind === 'exchange' && !LIVE_STATES.has(entry.state))) setFollowing(null);
  }, [following, entries, stream.error]);
  useEffect(() => {
    // The run ended and the thread has not caught up: give it a moment, then hand the composer back regardless.
    if (!stream.done) return;
    const t = setTimeout(() => setFollowing(null), 5000);
    return () => clearTimeout(t);
  }, [stream.done]);

  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [entries.length, posted?.runId, streamed]);

  const busy = posted !== null || following !== null;
  const send = (): void => { const text = draft.trim(); if (text && id && !busy) post.mutate(text); };
  const agent = report?.agent;

  return (
    <section aria-labelledby="orchestrator-title" data-testid="orchestrator-band" className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900/60">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The heading is the name alone; the state chip sits beside it, not inside its accessible name. */}
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle id="orchestrator-title" as="h2" className="text-lg">
              <Link to={`/agents/${agent?.id ?? 'companion'}?project=companion`} className="underline-offset-4 hover:underline">{agent?.name ?? 'Companion'}</Link>
            </CardTitle>
            <Badge tone={report ? STATE_TONE[report.state] : 'neutral'}>{report ? STATE_WORD[report.state] : 'loading'}</Badge>
          </div>
          <Hint className="mt-1">{agent?.description ?? 'The one agent you talk to, and the one that directs the others.'}</Hint>
        </div>
        <dl className="text-xs text-gray-700 dark:text-gray-300">
          {agent?.spend ? <div className="flex gap-2" data-testid="orchestrator-spent"><dt className="text-gray-600 dark:text-gray-400">Spent</dt><dd className="font-mono">{spentLine(agent.spend)}</dd></div> : null}
          {agent?.heartbeat ? <div className="flex gap-2" data-testid="orchestrator-pulse"><dt className="text-gray-600 dark:text-gray-400">Pulse</dt><dd>{heartbeatLine(agent.heartbeat)}</dd></div> : null}
        </dl>
      </div>

      <Subheading className="mt-4">Since you were last here</Subheading>
      {header ? <SinceLines header={header} /> : <Hint className="mt-1">Reading the room…</Hint>}

      {children}

      <Subheading className="mt-6" id="thread-title">The conversation</Subheading>
      {thread.isError ? <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">Could not open the thread: {thread.error.message}</p> : null}
      <div ref={log} role="log" aria-labelledby="thread-title" data-testid="thread" className="mt-2 max-h-[22rem] space-y-3 overflow-y-auto rounded-md border border-gray-200 bg-white p-3 md:max-h-[28rem] dark:border-gray-800 dark:bg-gray-950">
        {entries.length === 0 && !posted ? <Hint>Nothing said yet. Ask it what the others have been doing.</Hint> : null}
        {entries.map((e) => (
          <Entry
            key={e.kind === 'decision' ? `d-${e.item.id}` : e.runId}
            entry={e}
            live={e.kind === 'exchange' && e.runId === following ? shown.current : undefined}
            who={agent?.name ?? 'Companion'}
            onAnswer={(item, a) => answer.mutate({ id: item, answer: a })}
            answering={answer.isPending}
          />
        ))}
        {posted ? (
          <div data-testid="pending-exchange">
            <Bubble who="You" text={posted.you} />
            <Bubble who={agent?.name ?? 'Companion'} text={shown.current || '…'} live />
          </div>
        ) : null}
      </div>

      <form className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <label className="flex-1 text-sm">
          <span className="sr-only">Message to the orchestrator</span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}
            rows={2}
            placeholder={busy ? 'Waiting for its answer…' : 'Say something. Ctrl+Enter sends.'}
            disabled={!id || busy}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
          />
        </label>
        <Button type="submit" disabled={!id || busy || draft.trim() === '' || post.isPending}>{post.isPending ? 'Sending…' : 'Send'}</Button>
      </form>
      {post.isError ? <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">{post.error.message}</p> : null}
    </section>
  );
}

/** What happened since the room was last read, each line a link to the screen that holds it. Only what is non-zero. */
function SinceLines({ header: h }: { header: ThreadHeader }) {
  const since = h.since ? `since ${new Date(h.since).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'ever';
  const lines: { key: string; to: string; text: string }[] = [];
  if (h.finished || h.failed) lines.push({ key: 'runs', to: '/runs', text: `${h.finished} run${h.finished === 1 ? '' : 's'} finished${h.failed ? `, ${h.failed} failed` : ''}, ${money(h.spentUsd)} spent` });
  if (h.running) lines.push({ key: 'running', to: '/runs', text: `${h.running} running now` });
  if (h.needsYou.decisions) lines.push({ key: 'decisions', to: '#needs-you', text: `${h.needsYou.decisions} decision${h.needsYou.decisions === 1 ? '' : 's'} waiting on you` });
  if (h.needsYou.reviews) lines.push({ key: 'reviews', to: '/review', text: `${h.needsYou.reviews} run${h.needsYou.reviews === 1 ? '' : 's'} held for your review` });
  if (h.needsYou.approvals) lines.push({ key: 'approvals', to: '#needs-you', text: `${h.needsYou.approvals} permission${h.needsYou.approvals === 1 ? '' : 's'} asked` });
  if (h.needsYou.unrated) lines.push({ key: 'unrated', to: '/review', text: `${h.needsYou.unrated} output${h.needsYou.unrated === 1 ? '' : 's'} would like a rating` });
  return (
    <div data-testid="since-lines">
      <Hint className="mt-1">{since}.</Hint>
      {lines.length === 0 ? <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">Nothing happened while you were away.</p> : (
        <ul className="mt-1 text-sm">
          {/* Each line is a target of its own (WCAG 2.5.8): padded to a box, not a bare line of text. */}
          {lines.map((l) => <li key={l.key}><Link to={l.to} className="inline-block py-1 text-blue-700 underline underline-offset-4 dark:text-sky-300">{l.text}</Link></li>)}
        </ul>
      )}
    </div>
  );
}

/** An exchange whose run is still in one of these has no reply yet: what has streamed stands in for it. */
const LIVE_STATES = new Set(['queued', 'running', 'waiting_review', 'waiting_approval']);

function Entry({ entry: e, live, who, onAnswer, answering }: {
  entry: ThreadEntry;
  /** The reply as it is arriving, for the one exchange being followed. */
  live: string | undefined;
  who: string;
  onAnswer: (item: string, answer: string) => void;
  answering: boolean;
}) {
  // The same card as under Needs you, drawn once (DecisionCard); its own id here, since the board shows both.
  if (e.kind === 'decision') return <DecisionCard item={e.item} onAnswer={(a) => onAnswer(e.item.id, a)} pending={answering} testId={`thread-decision-${e.item.id}`} />;
  const meta = (
    <Hint className="mt-1">
      {money(e.costUsd)} · <Link to={`/runs/${e.runId}`} className="underline underline-offset-4">its trace</Link>
      {e.children ? ` · directed ${e.children} run${e.children === 1 ? '' : 's'}` : ''}
      {e.kind === 'exchange' && e.tainted ? ' · this turn read something from outside' : ''}
      {e.state !== 'completed' ? ` · ${e.state}` : ''}
    </Hint>
  );
  if (e.kind === 'pulse') {
    return (
      <div data-testid={`pulse-${e.runId}`}>
        <Bubble who="The pulse" text={e.note ?? '(no note)'} />
        {meta}
        {e.filed.length ? <ul className="mt-1 space-y-1">{e.filed.map((w) => <li key={w.id}><WorkRow item={w} /></li>)}</ul> : null}
      </div>
    );
  }
  const arriving = e.reply === null && live !== undefined && LIVE_STATES.has(e.state);
  return (
    <div data-testid={`exchange-${e.runId}`}>
      <Bubble who="You" text={e.you} />
      <Bubble who={who} text={e.reply ?? (arriving ? live || '…' : e.state === 'failed' ? '(the run failed)' : '…')} live={arriving} />
      {meta}
      {e.filed.length ? <ul className="mt-1 space-y-1">{e.filed.map((w) => <li key={w.id}><WorkRow item={w} /></li>)}</ul> : null}
    </div>
  );
}

/** One turn. Plain text in a block, as documents and outputs are everywhere else: no renderer, no surprises. */
function Bubble({ who, text, live }: { who: string; text: string; live?: boolean }) {
  return (
    <div className="mt-2 first:mt-0">
      <p className="text-xs font-medium text-gray-600 dark:text-gray-400">{who}</p>
      <pre aria-live={live ? 'polite' : undefined} className="mt-0.5 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 font-sans text-sm dark:bg-gray-900">{text}{live ? <span aria-hidden="true" className="opacity-60">▌</span> : null}</pre>
    </div>
  );
}
