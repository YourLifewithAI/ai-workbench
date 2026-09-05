import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { Estimate } from '../components/Estimate.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';

export function Agents() {
  const q = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const client = useQueryClient();
  const reload = useMutation({ mutationFn: api.reloadAgents, onSuccess: () => client.invalidateQueries({ queryKey: ['agents'] }) });

  return (
    <section aria-labelledby="screen-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 id="screen-title" className="text-2xl font-semibold">Agents</h1>
        <Button variant="secondary" size="sm" onClick={() => reload.mutate()} disabled={reload.isPending}>
          {reload.isPending ? 'Reloading…' : 'Reload from disk'}
        </Button>
      </div>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Agents are files in <code className="font-mono">agents/</code> in your workspace. Edit one and reload; the version hash changes with it.
      </p>

      {q.isPending ? <p className="mt-4" role="status">Loading agents…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load agents: {q.error.message}</p> : null}

      {q.data?.errors.length ? (
        <div className="mt-4 space-y-2" role="alert">
          {q.data.errors.map((e) => (
            <Card key={e.id} className="border-l-4 border-l-red-600 dark:border-l-red-400">
              <p className="font-medium">{e.id} did not load.</p>
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{e.message}</p>
              <p className="mt-1 break-all font-mono text-xs text-gray-600 dark:text-gray-400">{e.file}</p>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Fix the file, then <button type="button" className="underline underline-offset-4" onClick={() => reload.mutate()}>reload</button>.</p>
            </Card>
          ))}
        </div>
      ) : null}

      {q.data && q.data.agents.length === 0 && q.data.errors.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No agents in this workspace yet. An agent is one JSON file and a Markdown file of instructions." />
        </div>
      ) : null}

      {q.data?.agents.length ? (
        <ul className="mt-4 grid gap-3 md:grid-cols-2">
          {q.data.agents.map((a) => (
            <li key={a.id}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-medium">
                      <Link to={`/agents/${a.id}`} className="underline-offset-4 hover:underline">{a.name}</Link>
                    </h2>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{a.description}</p>
                  </div>
                  <Badge>{a.id}</Badge>
                </div>
                <dl className="mt-3 space-y-1 text-sm">
                  <div className="flex gap-2"><dt className="text-gray-600 dark:text-gray-400">Model</dt><dd className="font-mono text-xs">{a.modelPolicy.primary}{a.modelPolicy.primary.startsWith('role:') ? ` → ${a.modelPolicy.now[0] ?? 'nothing ready'}` : ''}</dd></div>
                  {a.modelPolicy.fallbacks.length ? (
                    <div className="flex gap-2"><dt className="text-gray-600 dark:text-gray-400">Falls back to</dt><dd className="font-mono text-xs">{a.modelPolicy.fallbacks.join(', ')}</dd></div>
                  ) : null}
                  <div className="flex gap-2"><dt className="text-gray-600 dark:text-gray-400">Version</dt><dd className="break-all font-mono text-xs">{a.version.replace('sha256:', '').slice(0, 12)}</dd></div>
                </dl>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function AgentDetail() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['agent', id], queryFn: () => api.agent(id), enabled: id !== '' });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, staleTime: 60_000 });
  const [input, setInput] = useState('');
  const [model, setModel] = useState('');
  const [project, setProject] = useState('');
  const [useMock, setUseMock] = useState<boolean | null>(null);
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 60_000 });
  const navigate = useNavigate();
  const client = useQueryClient();

  // Default to whichever the workspace can actually do: the mock while no key exists, the real policy once one does.
  const hasKey = (settings.data?.providersConfigured.length ?? 0) > 0;
  const mock = useMock ?? !hasKey;

  const start = useMutation({
    mutationFn: () => api.createRun({
      kind: 'agent',
      id,
      inputs: { input },
      ...(project ? { project } : {}),
      ...(mock ? { provider: 'mock' as const } : {}),
      ...(model.trim() ? { overrides: { model: model.trim() } } : {}),
    }),
    onSuccess: ({ runId }) => {
      void client.invalidateQueries({ queryKey: ['runs'] });
      navigate(`/runs/${runId}`);
    },
  });

  return (
    <section aria-labelledby="screen-title">
      <p className="text-sm"><Link to="/agents" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">← All agents</Link></p>
      {q.isError ? <p role="alert" className="mt-3 text-red-700 dark:text-red-300">{q.error.message}</p> : null}
      <h1 id="screen-title" className="mt-2 text-2xl font-semibold">{q.data?.name ?? id}</h1>
      {q.data ? (
        <>
          <p className="mt-1 text-gray-700 dark:text-gray-300">{q.data.description}</p>

          <Card className="mt-4">
            <h2 className="font-medium">Run it</h2>
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => { e.preventDefault(); if (input.trim()) start.mutate(); }}
            >
              <div>
                <label htmlFor="task" className="block text-sm font-medium">Task</label>
                <p className="text-xs text-gray-600 dark:text-gray-400">Sent as the first user message. Everything above it is the agent&apos;s own instructions.</p>
                <textarea id="task" rows={4} value={input} onChange={(e) => setInput(e.target.value)} className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950" placeholder="A dentist finds binary in his patients' tooth decay." />
              </div>
              <Estimate request={{ kind: 'agent', id: q.data.id, inputs: { input }, ...(model ? { overrides: { model } } : {}) }} mock={mock} />
              <div className="flex flex-wrap items-end gap-4">
                <div className="min-w-56 flex-1">
                  <label htmlFor="model" className="block text-sm font-medium">Model override</label>
                  <input id="model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={q.data.modelPolicy.primary} className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950" />
                </div>
                <div className="min-w-48">
                  <label htmlFor="project" className="block text-sm font-medium">Target project</label>
                  <select id="project" value={project} onChange={(e) => setProject(e.target.value)} className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950">
                    <option value="">none — output stays in the run</option>
                    {projects.data?.map((p) => <option key={p.slug} value={p.slug}>{p.slug}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-2 py-2 text-sm">
                  <input type="checkbox" checked={mock} onChange={(e) => setUseMock(e.target.checked)} className="h-6 w-6" />
                  Use the mock provider (free, no key)
                </label>
                <Button type="submit" disabled={!input.trim() || start.isPending}>{start.isPending ? 'Starting…' : 'Run'}</Button>
              </div>
            </form>
            {start.isError ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{start.error.message}</p> : null}
          </Card>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card>
              <h2 className="font-medium">Definition</h2>
              <dl className="mt-2 text-sm">
                <Row k="Primary model" v={q.data.modelPolicy.primary} mono />
                <Row k="Would run on" v={q.data.modelPolicy.now.length ? q.data.modelPolicy.now.join(', ') : 'nothing is ready: add a key in Settings, or change the role there'} mono />
                <Row k="Fallbacks" v={q.data.modelPolicy.fallbacks.join(', ') || 'none'} mono />
                <Row k="Version" v={q.data.version} mono />
                <Row k="Instructions" v={q.data.instructionsSource === 'file' ? 'instructions.md' : 'inline in agent.json'} />
                <Row k="Tools" v={q.data.tools.join(', ') || 'none'} />
                <Row k="Output" v={q.data.outputKind} />
                <Row k="Review" v={q.data.review} />
                <Row k="Injects documents" v={q.data.documents.join(', ') || 'none'} />
              </dl>
            </Card>
            <Card>
              <h2 className="font-medium">Instruction sections</h2>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Rendered in this order at the top of every system prompt. The version hash covers exactly this.</p>
              <div className="mt-2 space-y-3">
                {q.data.sections.map((s) => (
                  <details key={s.name} className="rounded border border-gray-200 dark:border-gray-800">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-medium">## {s.name}</summary>
                    <pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-gray-100 px-3 py-2 font-mono text-xs dark:border-gray-800">{s.text}</pre>
                  </details>
                ))}
              </div>
            </Card>
          </div>
        </>
      ) : null}
    </section>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b border-gray-100 py-1 last:border-b-0 dark:border-gray-800">
      <dt className="text-gray-600 dark:text-gray-400">{k}</dt>
      <dd className={mono ? 'break-all text-right font-mono text-xs' : 'text-right'}>{v}</dd>
    </div>
  );
}
