// One decision as a card (D-75): the question, the case, the options as buttons, the orchestrator's lean marked.
// Answering is `PUT /work/:id`, the one way a decision gets an answer; the next pulse reads it. Shown under
// Needs you and inside the orchestrator's thread, drawn once.
import type { WorkItem } from '../../shared/api/index.js';
import { Button } from './ui/button.js';
import { Badge, Card } from './ui/card.js';
import { Subheading } from './ui/text.js';

/** An answered card leaves the page and takes focus with it: hand focus back to the section it left. */
export function refocusNeedsYou(): void {
  if (document.activeElement && document.activeElement !== document.body) return;
  document.getElementById('needs-you')?.focus();
}

export function DecisionCard({ item, onAnswer, pending, testId }: { item: WorkItem; onAnswer: (answer: string) => void; pending: boolean; testId?: string }) {
  return (
    <Card className="border-l-4 border-l-blue-700 dark:border-l-sky-400" data-testid={testId ?? `decision-${item.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Subheading as="h3" className="break-words">{item.title}</Subheading>
          {item.detail ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{item.detail}</p> : null}
        </div>
        <div className="flex gap-2">
          <Badge tone="busy">decision</Badge>
          {item.trust === 'untrusted' ? <Badge tone="neutral">written by a run that read outside</Badge> : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {item.options.map((o) => (
          <Button key={o.id} size="sm" variant={o.id === item.lean ? 'default' : 'secondary'} className="h-auto max-w-full whitespace-normal break-words py-2 text-left" onClick={() => onAnswer(o.id)} disabled={pending} title={o.detail ?? undefined}>
            {o.label}{o.id === item.lean ? ' (its lean)' : ''}<span className="sr-only"> — answer to: {item.title}</span>
          </Button>
        ))}
      </div>
    </Card>
  );
}

const STATE_TONE: Record<WorkItem['state'], 'good' | 'bad' | 'busy' | 'neutral'> = {
  backlog: 'neutral', staffed: 'busy', 'in-review': 'busy', 'needs-you': 'bad', decided: 'good', done: 'good', dropped: 'neutral',
};

/** One ledger item as a line: its state, its title, and whose words it carries. */
export function WorkRow({ item }: { item: WorkItem }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge tone={STATE_TONE[item.state]}>{item.state}</Badge>
      <span className="min-w-0 break-words font-medium">{item.title}</span>
      <span className="min-w-0 break-words text-xs text-gray-600 dark:text-gray-400">
        {item.kind}{item.project ? ` · ${item.project}` : ''}{item.assignee ? ` · ${item.assignee}` : ''}
        {item.trust === 'untrusted' ? ' · written by a run that read outside' : ''}
        {item.answer ? ` · answered: ${item.options.find((o) => o.id === item.answer)?.label ?? item.answer}` : ''}
      </span>
    </div>
  );
}
