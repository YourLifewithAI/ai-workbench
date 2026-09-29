// The orchestrator's band across the top of the board (D-77, D-79): who it is and what it has cost, what happened
// since the owner was last here, whatever the board says needs him (passed in), the thread, and the composer.
// Every exchange is an ordinary run; posting a message starts it and the one follower streams the reply back.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { AgentReport, ThreadEntry, ThreadHeader } from '../../shared/api/index.js';
import { ApiRequestError, api } from '../lib/api.js';
import { STATE_TONE, STATE_WORD, heartbeatLine, money, spentLine } from '../lib/agentLines.js';
import { useRunStream } from '../lib/useRunStream.js';
import { DecisionCard, WorkRow, refocusNeedsYou } from './DecisionCard.js';
import { Button } from './ui/button.js';
import { Badge } from './ui/card.js';
import { CardTitle, Hint, Subheading } from './ui/text.js';

/** A run in one of these has no reply yet: what has streamed stands in for it, and nothing else may be said. */
const ANSWERING = new Set(['queued', 'running']);
const isAnswering = (e: ThreadEntry): boolean => e.kind === 'exchange' && ANSWERING.has(e.state);

/** What needs the owner right now, from the live dashboard: the header is frozen for the visit, this is not. */
export interface LiveNeeds { decisions: number; reviews: number; approvals: number; unrated: number }

export function OrchestratorBand({ report, live, children }: { report: AgentReport | null; live?: LiveNeeds | undefined; children?: ReactNode }) {
  const client = useQueryClient();
  // Two states, because a message is a run and the thread lists a run from the moment it starts: `posted` is
  // the gap between the 202 and the thread having the exchange; `following` is the run whose reply is arriving.
  const [posted, setPosted] = useState<{ runId: string; you: string } | null>(null);
  const [following, setFollowing] = useState<string | null>(null);

  const latest = useQuery({ queryKey: ['conversation-latest'], queryFn: () => api.conversationLatest(), staleTime: 60_000 });
  const id = latest.data?.id ?? null;
  // While an answer is on its way the thread is polled as well as pushed to: a phone that locked its screen has
  // lost its live streams, and the thread is the truth about whether the run finished.
  const thread = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.conversation(id!),
    enabled: id !== null,
    refetchInterval: (q) => (posted || following || q.state.data?.entries.some(isAnswering) ? 3000 : false),
  });
  const entries = thread.data?.entries ?? [];

  // "Since you were last here" is fixed for this visit: held from the first FRESH load — a cached thread from an
  // earlier visit would show what was true then — and then the room is marked read once. Later refetches bring
  // new entries, not a new header; that one waits for the next visit.
  const [header, setHeader] = useState<ThreadHeader | null>(null);
  const marked = useRef<string | null>(null);
  const mountedAt = useRef(Date.now());
  const fetchedNow = thread.isSuccess && thread.dataUpdatedAt >= mountedAt.current;
  useEffect(() => {
    if (!thread.data || !fetchedNow || header) return;
    setHeader(thread.data.header);
    if (marked.current !== thread.data.conversation.id) {
      marked.current = thread.data.conversation.id;
      api.markRead(thread.data.conversation.id).catch(() => undefined);
    }
  }, [thread.data, fetchedNow, header]);

  const [draft, setDraft] = useState('');
  const sending = useRef(false);
  const post = useMutation({
    mutationFn: (message: string) => api.postMessage(id!, message),
    onSuccess: ({ runId }, message) => { setPosted({ runId, you: message }); setFollowing(runId); setDraft(''); },
    // Another tab or the CLI has a run of this thread going: the thread will show it (and poll while it runs).
    onError: (e) => { if (e instanceof ApiRequestError && e.status === 409) void client.invalidateQueries({ queryKey: ['conversation'] }); },
    onSettled: () => { sending.current = false; },
  });
  const stream = useRunStream(following, ['conversation', 'fleet', 'dashboard']);
  // A fresh conversation carries nothing of this one — including anything the agent read from outside, which
  // rides a thread from turn to turn (D-78). It starts read, so its header says nothing happened while away.
  const fresh = useMutation({
    mutationFn: async () => {
      const created = await api.newConversation(report?.agent.id ?? 'companion', latest.data?.project ?? undefined);
      await api.markRead(created.id);
      return { created, thread: await api.conversation(created.id) };
    },
    onSuccess: ({ created, thread: opened }) => {
      client.setQueryData(['conversation-latest'], created);
      client.setQueryData(['conversation', created.id], opened);
      marked.current = created.id;
      setHeader(opened.header);
      setDraft('');
    },
  });
  const answer = useMutation({
    mutationFn: (input: { id: string; answer: string }) => api.updateWork(input.id, { answer: input.answer }),
    // The same three queries as the card under Needs you refreshes: whichever copy was answered, both go.
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['conversation'] }),
      client.invalidateQueries({ queryKey: ['dashboard'] }),
      client.invalidateQueries({ queryKey: ['fleet'] }),
    ]).then(refocusNeedsYou),
  });

  // What has streamed so far stays on the entry until its reply is written, so nothing blinks between the two.
  const shown = useRef('');
  const streamed = Object.values(stream.streaming).join('');
  if (streamed) shown.current = streamed;
  // The gap bubble is shown only while the thread does not have the exchange yet: derived, not an effect's echo.
  const gap = posted !== null && !entries.some((e) => e.kind !== 'decision' && e.runId === posted.runId);
  useEffect(() => { if (posted && !gap) setPosted(null); }, [posted, gap]);
  useEffect(() => {
    if (!following) { shown.current = ''; return; }
    const entry = entries.find((e) => e.kind === 'exchange' && e.runId === following);
    // Done when the thread says so; and if the follower itself fails, the composer is given back — the run
    // goes on without it, and the polled thread says how it ended.
    if (stream.error || (entry && !isAnswering(entry))) setFollowing(null);
  }, [following, entries, stream.error]);
  useEffect(() => {
    // The run ended and the thread has not caught up: give it a moment, then hand the composer back regardless.
    if (!stream.done) return;
    const t = setTimeout(() => { setFollowing(null); setPosted(null); }, 5000);
    return () => clearTimeout(t);
  }, [stream.done]);

  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [entries.length, gap, streamed]);

  // Busy from every side: the request in flight, the gap, the run being followed, and what the server says is
  // still answering (another tab, the CLI). The textarea stays focusable — read-only, not disabled — so focus
  // and the hotkeys stay where the person left them.
  const busy = post.isPending || gap || following !== null || entries.some(isAnswering) || fresh.isPending;
  const box = useRef<HTMLTextAreaElement>(null);
  const send = (): void => {
    const text = draft.trim();
    if (!text || !id || busy || sending.current) return;
    sending.current = true;
    post.mutate(text);
    if (window.matchMedia?.('(pointer: fine)').matches) box.current?.focus();
  };
  const agent = report?.agent;

  // One polite line for a screen reader, instead of every streamed chunk.
  const [said, setSaid] = useState('');
  const answering = gap || following !== null || entries.some(isAnswering);
  const wasAnswering = useRef(false);
  const lastExchange = [...entries].reverse().find((e) => e.kind === 'exchange');
  useEffect(() => {
    const name = agent?.name ?? 'The companion';
    if (answering && !wasAnswering.current) setSaid(`${name} is answering.`);
    if (!answering && wasAnswering.current) {
      const state = lastExchange?.kind === 'exchange' ? lastExchange.state : 'completed';
      setSaid(state === 'completed' ? `${name} answered.` : state === 'cancelled' ? `${name}'s answer was cancelled.` : `${name} could not answer.`);
    }
    wasAnswering.current = answering;
  }, [answering, agent?.name, lastExchange]);

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
      {header ? <SinceLines header={header} live={live} /> : <Hint className="mt-1">{thread.isError || latest.isError ? 'Could not read what happened while you were away.' : 'Reading the room…'}</Hint>}

      {children}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <Subheading id="thread-title">The conversation</Subheading>
        <Button type="button" size="sm" variant="ghost" onClick={() => fresh.mutate()} disabled={!id || busy}>New conversation</Button>
      </div>
      {entries.some((e) => (e.kind === 'exchange' || e.kind === 'pulse') && e.tainted) ? (
        <Hint className="mt-1">Something read from outside is carried through this conversation, so what it remembers is marked as not yours. A new conversation starts clean.</Hint>
      ) : null}
      {latest.isError ? <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">Could not find your conversation with the companion: {latest.error.message}</p> : null}
      {thread.isError ? <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">Could not open the thread: {thread.error.message}</p> : null}
      <div
        ref={log}
        role="log"
        tabIndex={0}
        aria-labelledby="thread-title"
        aria-busy={busy}
        aria-live={busy ? 'off' : 'polite'}
        data-testid="thread"
        className="mt-2 max-h-[22rem] space-y-3 overflow-y-auto rounded-md border border-gray-200 bg-white p-3 md:max-h-[28rem] dark:border-gray-800 dark:bg-gray-950"
      >
        {thread.isSuccess && entries.length === 0 && !gap ? <Hint>Nothing said yet. Ask it what the others have been doing.</Hint> : null}
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
        {gap && posted ? (
          <div data-testid="pending-exchange">
            <Bubble who="You" text={posted.you} />
            <Bubble who={agent?.name ?? 'Companion'} text={shown.current || '…'} live />
          </div>
        ) : null}
      </div>
      <p role="status" className="sr-only">{said}</p>
      <Hint className="mt-2 hidden md:block">Ctrl or Cmd+Enter sends.</Hint>

      <form className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <label className="flex-1 text-sm">
          <span className="sr-only">Message to the orchestrator</span>
          <textarea
            ref={box}
            value={draft}
            onChange={(e) => { if (!busy) { setDraft(e.target.value); if (post.isError) post.reset(); } }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
              if (e.key === 'Escape') e.currentTarget.blur();
            }}
            rows={2}
            readOnly={busy}
            disabled={!id}
            aria-disabled={busy || !id}
            placeholder={busy ? 'Waiting for its answer…' : 'Say something.'}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base md:text-sm dark:border-gray-700 dark:bg-gray-950"
          />
        </label>
        <Button type="submit" disabled={!id || busy || draft.trim() === ''}>{post.isPending ? 'Sending…' : 'Send'}</Button>
      </form>
      {post.isError ? <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">{post.error.message}</p> : null}
      {answer.isError ? <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">{answer.error.message}</p> : null}
      {fresh.isError ? <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">Could not start a new conversation: {fresh.error.message}</p> : null}
    </section>
  );
}

/** What happened since the room was last read, each line a link to the screen that holds it. Only what is non-zero. */
function SinceLines({ header: h, live }: { header: ThreadHeader; live: LiveNeeds | undefined }) {
  const needs = live ?? h.needsYou;
  const since = h.since ? `Since ${new Date(h.since).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : 'First visit: everything so far.';
  const nothing = h.since ? 'Nothing happened while you were away.' : 'Nothing has happened yet.';
  const lines: { key: string; to: string; text: string }[] = [];
  if (h.finished || h.failed) lines.push({ key: 'runs', to: '/runs', text: `${h.finished} run${h.finished === 1 ? '' : 's'} finished${h.failed ? `, ${h.failed} failed` : ''}` });
  if (h.spentUsd > 0) lines.push({ key: 'spent', to: '/runs', text: `${money(h.spentUsd)} spent${h.since ? ' while you were away' : ' so far'}` });
  if (h.running) lines.push({ key: 'running', to: '/runs', text: `${h.running} running now` });
  if (needs.decisions) lines.push({ key: 'decisions', to: '#needs-you', text: `${needs.decisions} decision${needs.decisions === 1 ? '' : 's'} waiting on you` });
  if (needs.reviews) lines.push({ key: 'reviews', to: '/review', text: `${needs.reviews} run${needs.reviews === 1 ? '' : 's'} held for your review` });
  if (needs.approvals) lines.push({ key: 'approvals', to: '#needs-you', text: `${needs.approvals} permission${needs.approvals === 1 ? '' : 's'} asked` });
  if (needs.unrated) lines.push({ key: 'unrated', to: '/review', text: `${needs.unrated} output${needs.unrated === 1 ? '' : 's'} would like a rating` });
  const target = 'inline-flex min-h-11 items-center py-1 text-blue-700 underline underline-offset-4 md:min-h-0 dark:text-sky-300';
  return (
    <div data-testid="since-lines">
      <Hint className="mt-1">{since}</Hint>
      {lines.length === 0 ? <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{nothing}</p> : (
        <ul className="mt-1 text-sm">
          {lines.map((l) => (
            <li key={l.key}>
              {l.to.startsWith('#') ? (
                // A hash link inside a BrowserRouter changes the address and scrolls nowhere: scroll it ourselves.
                <a href={l.to} className={target} onClick={(ev) => { ev.preventDefault(); const el = document.getElementById(l.to.slice(1)); el?.scrollIntoView({ block: 'start' }); el?.focus(); }}>{l.text}</a>
              ) : (
                <Link to={l.to} className={target}>{l.text}</Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
    <Hint className="mt-1 break-words">
      {money(e.costUsd)} · <Link to={`/runs/${e.runId}`} className="inline-flex min-h-11 items-center underline underline-offset-4 md:min-h-0">its trace</Link>
      {e.children ? ` · directed ${e.children} run${e.children === 1 ? '' : 's'}` : ''}
      {e.state !== 'completed' ? ` · ${e.state}` : ''}
    </Hint>
  );
  const outside = e.tainted ? <Badge tone="neutral">carried something read from outside</Badge> : null;
  if (e.kind === 'pulse') {
    return (
      <div data-testid={`pulse-${e.runId}`}>
        <Bubble who="The pulse" text={e.note ?? (ANSWERING.has(e.state) ? '…' : '(no note)')} badge={outside} />
        {meta}
        {e.filed.length ? <ul className="mt-1 space-y-1">{e.filed.map((w) => <li key={w.id}><WorkRow item={w} /></li>)}</ul> : null}
      </div>
    );
  }
  const arriving = e.reply === null && live !== undefined && ANSWERING.has(e.state);
  const stand = e.state === 'waiting_approval' ? '(waiting for your permission — see Needs you)' : e.state === 'waiting_review' ? '(waiting for your review — see Needs you)' : e.state === 'failed' ? `(the run failed${e.error ? `: ${e.error}` : ''})` : e.state === 'cancelled' ? '(cancelled)' : e.state === 'interrupted' ? '(interrupted by a restart)' : '…';
  return (
    <div data-testid={`exchange-${e.runId}`}>
      <Bubble who="You" text={e.you} />
      <Bubble who={who} text={e.reply ?? (arriving ? live || '…' : stand)} live={arriving} badge={outside} />
      {meta}
      {e.filed.length ? <ul className="mt-1 space-y-1">{e.filed.map((w) => <li key={w.id}><WorkRow item={w} /></li>)}</ul> : null}
    </div>
  );
}

/** One turn. Plain text in a block, as documents and outputs are everywhere else: no renderer, no surprises. */
function Bubble({ who, text, live, badge }: { who: string; text: string; live?: boolean; badge?: ReactNode }) {
  return (
    <div className="mt-2 first:mt-0">
      <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-400">{who}{badge}</p>
      <pre data-live={live ? 'true' : undefined} className="mt-0.5 whitespace-pre-wrap break-words rounded bg-gray-50 p-2 font-sans text-sm dark:bg-gray-900">{text}{live ? <span aria-hidden="true" className="opacity-60">▌</span> : null}</pre>
    </div>
  );
}
