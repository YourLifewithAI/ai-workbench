// What agents remember (ui.md §Memory, D-17, D-35). Every item shows where it came from and how far it may be
// believed; deleting one offers to take its content out of the traces that quoted it, because a memory you
// deleted that is still legible in an old run has not really been deleted.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { MemoryItem } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';

const SCOPE_NOTE: Record<string, string> = {
  agent: 'only this agent retrieves it',
  project: 'everyone working in this project retrieves it',
  workspace: 'every agent retrieves it',
  user: 'about you, and every agent retrieves it',
};

const SOURCE_NOTE: Record<string, string> = {
  user: 'you wrote it',
  'agent-tool': 'an agent chose to remember it',
  import: 'imported',
};

export function Memory() {
  const client = useQueryClient();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [pendingDelete, setPendingDelete] = useState<MemoryItem | null>(null);
  const [said, setSaid] = useState('');
  const [draft, setDraft] = useState('');
  const [draftScope, setDraftScope] = useState<'workspace' | 'user'>('workspace');

  const q = useQuery({
    queryKey: ['memory', query, scope],
    queryFn: () => api.memory({ ...(query ? { q: query } : {}), ...(scope ? { scope } : {}) }),
  });
  const traces = useQuery({
    queryKey: ['memory-traces', pendingDelete?.id],
    queryFn: () => api.memoryTraces(pendingDelete!.id),
    enabled: pendingDelete !== null,
  });

  const invalidate = (): void => { void client.invalidateQueries({ queryKey: ['memory'] }); };
  const add = useMutation({
    mutationFn: () => api.addMemory({ content: draft, scope: draftScope }),
    onSuccess: () => { setDraft(''); setSaid('Remembered.'); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (input: { id: string; redact: boolean }) => api.deleteMemory(input.id, input.redact),
    onSuccess: (result) => {
      setSaid(result.redactedRuns.length ? `Deleted, and redacted from ${result.redactedRuns.length} trace${result.redactedRuns.length === 1 ? '' : 's'}.` : 'Deleted.');
      setPendingDelete(null);
      invalidate();
    },
  });

  const items = q.data ?? [];

  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title" className="text-2xl font-semibold">Memory</h1>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        What agents carry between runs. An item written by a run that had read anything from outside the workspace —
        a web page, a search, an imported file — is <em>untrusted</em>: it is still retrieved, and it reaches the
        model fenced as data rather than as an instruction.
      </p>
      <p aria-live="polite" className="sr-only">{said}</p>

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); void q.refetch(); }}
      >
        <label className="block">
          <span className="block text-sm font-medium">Search</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="what an agent might have been told"
            className="mt-1 w-72 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium">Scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="mt-1 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950"
          >
            <option value="">every scope</option>
            <option value="agent">agent</option>
            <option value="project">project</option>
            <option value="workspace">workspace</option>
            <option value="user">user</option>
          </select>
        </label>
        <Button type="submit" variant="secondary">Search</Button>
      </form>

      <form
        className="mt-6 flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) add.mutate(); }}
      >
        <label className="block grow">
          <span className="block text-sm font-medium">Tell them something</span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="I write in British English and never use em dashes."
            className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium">Scope</span>
          <select
            value={draftScope}
            onChange={(e) => setDraftScope(e.target.value as 'workspace')}
            className="mt-1 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950"
          >
            <option value="workspace">every agent</option>
            <option value="user">about me</option>
          </select>
        </label>
        <Button type="submit" disabled={!draft.trim() || add.isPending}>Remember</Button>
      </form>
      {add.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{add.error.message}</p> : null}

      {q.isPending ? <p className="mt-6" role="status">Loading…</p> : null}
      {q.isError ? <p className="mt-6 text-red-700 dark:text-red-300" role="alert">Could not load memory: {q.error.message}</p> : null}

      {q.data && items.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={query || scope
            ? 'No item in this scope matches those words.'
            : 'Nothing is remembered yet. Agents remember with the memory.remember tool, and you can write an item yourself above — nothing is extracted automatically.'}
          />
        </div>
      ) : null}

      {items.length ? (
        <ul className="mt-6 space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <Card>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Badge tone={item.trust === 'trusted' ? 'good' : 'busy'}>{item.trust}</Badge>
                  <span className="font-mono text-xs">{item.scope}:{item.ownerId}</span>
                  <span className="text-xs text-gray-600 dark:text-gray-400">{SCOPE_NOTE[item.scope]}</span>
                </div>
                <p className="mt-2 text-sm">{item.content}</p>
                {item.trust === 'untrusted' ? (
                  <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                    The run that wrote this had read something from outside the workspace, so it reaches a model as data, never as an instruction.
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                  {SOURCE_NOTE[item.source] ?? item.source}
                  {' · '}<time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
                  {item.runId ? <> · <Link to={`/runs/${item.runId}`} className="underline underline-offset-4">the run that wrote it</Link></> : null}
                  {item.expiresAt ? <> · expires <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleDateString()}</time></> : null}
                </p>
                <div className="mt-2">
                  <Button variant="secondary" size="sm" onClick={() => { setPendingDelete(item); setSaid(''); }}>Delete…</Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      {pendingDelete ? (
        <div role="dialog" aria-modal="true" aria-labelledby="delete-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="max-w-lg">
            <h2 id="delete-title" className="text-lg font-medium">Delete this memory?</h2>
            <p className="mt-2 text-sm">{pendingDelete.content}</p>
            <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
              {traces.isPending
                ? 'Checking which traces quoted it…'
                : traces.data?.runIds.length
                  ? `It was quoted in ${traces.data.runIds.length} trace${traces.data.runIds.length === 1 ? '' : 's'}. Deleting the item does not change those.`
                  : 'No trace quoted it, so deleting it is the whole of it.'}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => remove.mutate({ id: pendingDelete.id, redact: false })} disabled={remove.isPending}>Delete</Button>
              {traces.data?.runIds.length ? (
                <Button variant="secondary" onClick={() => remove.mutate({ id: pendingDelete.id, redact: true })} disabled={remove.isPending}>
                  Delete and redact from {traces.data.runIds.length} trace{traces.data.runIds.length === 1 ? '' : 's'}
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => setPendingDelete(null)}>Cancel</Button>
            </div>
            {remove.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{remove.error.message}</p> : null}
          </Card>
        </div>
      ) : null}
    </section>
  );
}
