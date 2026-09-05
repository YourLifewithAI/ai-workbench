// The quality queue (D-13). Nothing here is blocked unless a step asked to be; the blocking ones sort first.
// Keyboard-first (D-59): `j`/`k` move, `1`–`5` rate, `c` continues a gate, `r` starts a rejection, `Esc` closes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { PermissionFinding, ReviewItem } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';
import { useLiveRuns } from './Runs.js';
import { CardTitle, Prose, ScreenTitle, SectionTitle } from '../components/ui/text.js';

export function Review() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['reviews'], queryFn: () => api.reviews('open') });
  useLiveRuns(['reviews', 'dashboard']);
  const items = useMemo(() => q.data ?? [], [q.data]);

  const [cursor, setCursor] = useState(0);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const [said, setSaid] = useState('');

  const current = items[Math.min(cursor, Math.max(0, items.length - 1))];

  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['reviews'] });
    void client.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const rate = useMutation({
    mutationFn: (input: { item: ReviewItem; value: number }) =>
      api.rate({ runId: input.item.runId, stepId: input.item.stepId, ...(input.item.versionId ? { versionId: input.item.versionId } : {}), value: input.value }),
    onSuccess: (_r, input) => { setSaid(`Rated ${input.value} out of 5.`); invalidate(); },
  });
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'continue' | 'reject' | 'dismiss'; feedback?: string }) =>
      api.decideReview(input.id, input.decision, input.feedback),
    onSuccess: (_r, input) => {
      setSaid(input.decision === 'continue' ? 'Accepted; the run carries on.' : input.decision === 'reject' ? 'Rejected; the step is re-running with your note.' : 'Dismissed.');
      setRejecting(null);
      setFeedback('');
      invalidate();
    },
  });

  useEffect(() => {
    if (rejecting) feedbackRef.current?.focus();
  }, [rejecting]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (e.key === 'Escape' && rejecting) { setRejecting(null); setFeedback(''); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !current) return;
      if (e.key === 'j') { setCursor((c) => Math.min(items.length - 1, c + 1)); e.preventDefault(); return; }
      if (e.key === 'k') { setCursor((c) => Math.max(0, c - 1)); e.preventDefault(); return; }
      if (e.key >= '1' && e.key <= '5') { rate.mutate({ item: current, value: Number(e.key) }); e.preventDefault(); return; }
      if (e.key === 'c' && current.blocking) { decide.mutate({ id: current.id, decision: 'continue' }); e.preventDefault(); return; }
      if (e.key === 'r') { setRejecting(current.id); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, items.length, rate, decide, rejecting]);

  return (
    <section aria-labelledby="screen-title">
      <ScreenTitle>Review</ScreenTitle>
      <Prose className="mt-1">
        Outputs wait here for your rating. Nothing is blocked unless a step asks.
        {' '}<span className="text-gray-600 dark:text-gray-400">Keys: <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> move · <kbd className="font-mono">1</kbd>–<kbd className="font-mono">5</kbd> rate · <kbd className="font-mono">c</kbd> continue · <kbd className="font-mono">r</kbd> reject.</span>
      </Prose>
      <p role="status" aria-live="polite" className="sr-only">{said}</p>

      <Findings />

      {q.isPending ? <p className="mt-4" role="status">Loading…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load the queue: {q.error.message}</p> : null}
      {q.data && items.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="Outputs wait here for your rating. Nothing is blocked unless a step asks.">
            <Button asChild variant="secondary"><Link to="/workflows">Run a workflow</Link></Button>
          </EmptyState>
        </div>
      ) : null}

      <ul className="mt-4 space-y-3">
        {items.map((item, index) => (
          <li key={item.id}>
            <Card className={index === cursor ? 'ring-2 ring-blue-700 dark:ring-sky-400' : undefined}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle>
                    {item.subject} <span className="font-mono text-xs text-gray-600 dark:text-gray-400">{item.stepId}</span>
                  </CardTitle>
                  <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                    <Link to={`/runs/${item.runId}`} className="underline underline-offset-4">run {item.runId.slice(-8)}</Link>
                    {item.modelId ? ` · ${item.modelId}` : ''}
                    {item.documentPath && item.documentId ? <> · <Link to={`/library/${item.project}/${item.documentId}`} className="underline underline-offset-4">{item.documentPath}</Link></> : null}
                    {item.attempt > 1 ? ` · attempt ${item.attempt}` : ''}
                  </p>
                </div>
                {item.blocking ? <Badge tone="busy">holding the run still</Badge> : <Badge>unreviewed</Badge>}
              </div>

              {item.feedback ? (
                <p className="mt-3 rounded border-l-4 border-l-amber-600 bg-amber-50 p-2 text-sm dark:border-l-amber-400 dark:bg-amber-950">
                  You asked for: {item.feedback}
                </p>
              ) : null}

              <pre tabIndex={0} className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-sm dark:bg-gray-950">{item.output ?? '(no output)'}</pre>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <fieldset className="flex items-center gap-1">
                  <legend className="float-left mr-2 text-sm text-gray-700 dark:text-gray-300">Rate</legend>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={item.ratings.at(-1)?.value === value ? 'default' : 'secondary'}
                      onClick={() => rate.mutate({ item, value })}
                      aria-pressed={item.ratings.at(-1)?.value === value}
                    >
                      {value}<span className="sr-only"> out of 5</span>
                    </Button>
                  ))}
                </fieldset>
                {item.blocking ? (
                  <Button size="sm" onClick={() => decide.mutate({ id: item.id, decision: 'continue' })} disabled={decide.isPending}>Continue the run</Button>
                ) : null}
                <Button size="sm" variant="secondary" onClick={() => setRejecting(item.id)}>Reject with feedback</Button>
                <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: item.id, decision: 'dismiss' })} disabled={decide.isPending}>Dismiss</Button>
              </div>

              {rejecting === item.id ? (
                <form
                  className="mt-3"
                  onSubmit={(e) => { e.preventDefault(); decide.mutate({ id: item.id, decision: 'reject', feedback }); }}
                >
                  <label htmlFor={`feedback-${item.id}`} className="block text-sm font-medium">What do you want instead?</label>
                  <p id={`hint-${item.id}`} className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                    The step re-runs with this appended to its task. At most twice — after that the run carries on with what it has.
                  </p>
                  <textarea
                    id={`feedback-${item.id}`}
                    ref={feedbackRef}
                    required
                    rows={3}
                    aria-describedby={`hint-${item.id}`}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button type="submit" size="sm" disabled={decide.isPending}>Send it back</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setRejecting(null); setFeedback(''); }}>Cancel</Button>
                  </div>
                </form>
              ) : null}

              {item.ratings.length ? (
                <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">Rated {item.ratings.at(-1)!.value}/5{item.ratings.at(-1)!.note ? ` — ${item.ratings.at(-1)!.note}` : ''}</p>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
      {decide.isError ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{decide.error.message}</p> : null}
      {rate.isError ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{rate.error.message}</p> : null}
    </section>
  );
}

const KIND_LABEL: Record<PermissionFinding['kind'], string> = {
  unused: 'never used', unjustified: 'instructions moved on', reach: 'wider than the need', fatigue: 'approval fatigue', undecided: 'undecided',
};

/**
 * The permissions review's findings (D-63, RUN-14). Each is a proposal with the runtime's evidence and one
 * button that does exactly what it says; pressing it is the person writing the matrix, nothing else is.
 */
function Findings() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['findings'], queryFn: api.findings });
  const [said, setSaid] = useState('');
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'apply' | 'dismiss' }) => api.decideFinding(input.id, input.decision),
    onSuccess: (finding) => {
      setSaid(finding.state === 'applied' ? `Applied: ${finding.proposal?.label ?? 'the change'}.` : 'Dismissed until the facts change.');
      void client.invalidateQueries({ queryKey: ['findings'] });
      void client.invalidateQueries({ queryKey: ['tools'] });
    },
  });
  const findings = q.data ?? [];
  if (!findings.length) return <p role="status" aria-live="polite" className="sr-only">{said}</p>;
  return (
    <section aria-labelledby="findings-title" className="mt-8" data-testid="findings">
      <SectionTitle id="findings-title">Permissions review</SectionTitle>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        What the auditor noticed about the grant matrix. It can only propose; a button here is you changing a grant, the same as on the Tools screen.
      </p>
      <p role="status" aria-live="polite" className="sr-only">{said}</p>
      {decide.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{decide.error.message}</p> : null}
      <ul className="mt-3 space-y-3">
        {findings.map((f) => (
          <li key={f.id}>
            <Card className="border-l-4 border-l-amber-600 dark:border-l-amber-400" data-testid={`finding-${f.key}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <CardTitle as="h3">{f.headline}</CardTitle>
                <Badge>{KIND_LABEL[f.kind]}</Badge>
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300">
                {f.evidence.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
              {f.note ? <p className="mt-2 rounded border-l-4 border-l-gray-300 bg-gray-50 p-2 text-sm dark:border-l-gray-700 dark:bg-gray-950">The auditor adds: {f.note}</p> : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {f.proposal ? (
                  <Button size="sm" onClick={() => decide.mutate({ id: f.id, decision: 'apply' })} disabled={decide.isPending}>{f.proposal.label}</Button>
                ) : (
                  <span className="text-sm text-gray-700 dark:text-gray-300">Nothing to flip here; the change, if any, is yours to make on the Tools screen.</span>
                )}
                <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: f.id, decision: 'dismiss' })} disabled={decide.isPending}>Dismiss<span className="sr-only"> {f.headline}</span></Button>
                {f.runId ? <Link to={`/runs/${f.runId}`} className="text-sm underline underline-offset-4">the review run</Link> : null}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
