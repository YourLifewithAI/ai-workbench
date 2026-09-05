// One card per step that is waiting, with every action it wants listed on it (D-57). The risk line comes first
// in plain words, then the policy that fired, then three buttons with the narrowest "remember" as the default.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ApprovalItem } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { Button } from './ui/button.js';
import { Badge, Card } from './ui/card.js';
import { CardTitle } from './ui/text.js';

/** What this action would actually do, said plainly. The card is read under time pressure; the tool id is not enough. */
function riskLine(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'artifact.write':
      return `Write "${String(args['path'] ?? 'a document')}" into this run's project. Nothing is overwritten — it becomes a new version.`;
    case 'permission.request':
      return `${String(args['what'] ?? 'Something it cannot do')} — because ${String(args['why'] ?? 'no reason given')}.`;
    case 'agent.delegate':
      return `Hand a brief to the "${String(args['agent'] ?? 'another')}" agent and spend part of this run's budget on it.`;
    case 'http.request':
      return `Send data to ${String(args['url'] ?? 'a URL')}. This leaves the machine.`;
    default:
      return `Run ${tool} with ${JSON.stringify(args).slice(0, 160)}.`;
  }
}

export function ApprovalCard({ item, focused }: { item: ApprovalItem; focused?: boolean }) {
  const client = useQueryClient();
  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['approvals'] });
    void client.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const decide = useMutation({
    mutationFn: (input: { decision: 'allow' | 'allow-remember' | 'deny' }) => api.decideApproval(item.batchId, input.decision),
    onSuccess: invalidate,
  });

  const remember = item.actions.find((a) => a.remember)?.remember ?? null;
  const expires = new Date(item.expiresAt);

  return (
    <Card className={focused ? 'border-l-4 border-l-amber-600 ring-2 ring-blue-700 dark:border-l-amber-400 dark:ring-sky-400' : 'border-l-4 border-l-amber-600 dark:border-l-amber-400'}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle as="h3">
            {item.subject} <span className="font-mono text-xs text-gray-600 dark:text-gray-400">{item.stepId}</span>
          </CardTitle>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            <Link to={`/runs/${item.runId}`} className="underline underline-offset-4">run {item.runId.slice(-8)}</Link>
            {' · '}refused automatically at <time dateTime={item.expiresAt}>{expires.toLocaleTimeString()}</time> if nobody answers
          </p>
        </div>
        <Badge tone="busy">{item.actions.length === 1 ? 'wants permission' : `${item.actions.length} things`}</Badge>
      </div>

      <ol className="mt-3 space-y-2">
        {item.actions.map((action) => (
          <li key={action.id} className="rounded border border-gray-200 p-3 dark:border-gray-800">
            <p className="text-sm">{riskLine(action.tool, action.args)}</p>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
              <span className="font-mono">{action.tool}</span> · {action.policy}
            </p>
          </li>
        ))}
      </ol>

      <div className="mt-3 flex flex-wrap gap-2">
        {remember ? (
          <Button size="sm" onClick={() => decide.mutate({ decision: 'allow-remember' })} disabled={decide.isPending}>
            Allow and remember for {remember.path ? `${remember.path}/` : remember.host ?? 'this'}
          </Button>
        ) : null}
        <Button size="sm" variant={remember ? 'secondary' : 'default'} onClick={() => decide.mutate({ decision: 'allow' })} disabled={decide.isPending}>
          Allow once<span className="sr-only"> — {item.subject} step {item.stepId}</span>
        </Button>
        <Button size="sm" variant="secondary" onClick={() => decide.mutate({ decision: 'deny' })} disabled={decide.isPending}>
          Deny<span className="sr-only"> — {item.subject} step {item.stepId}</span>
        </Button>
      </div>
      {remember ? (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
          Remembering writes exactly <code className="font-mono">{JSON.stringify(remember)}</code> to this workspace — nothing wider.
        </p>
      ) : null}
      {decide.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{decide.error.message}</p> : null}
    </Card>
  );
}
