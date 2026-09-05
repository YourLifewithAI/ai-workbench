import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { DocumentVersionSummary } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';
import { CardTitle, Prose, ScreenTitle, SectionTitle } from '../components/ui/text.js';
import type { ProjectSpace } from '../../shared/project.js';

export function Library() {
  const q = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const create = useMutation({
    mutationFn: () => api.createProject({ slug: slug.trim(), name: slug.trim().replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }),
    onSuccess: () => { setCreating(false); setSlug(''); void client.invalidateQueries({ queryKey: ['projects'] }); },
  });

  return (
    <section aria-labelledby="screen-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <ScreenTitle>Library</ScreenTitle>
        <Button variant="secondary" size="sm" onClick={() => setCreating((v) => !v)}>{creating ? 'Cancel' : 'New project'}</Button>
      </div>
      <Prose className="mt-1">Projects hold what your agents make. Every version is kept, with the run and model that produced it.</Prose>

      {creating ? (
        <Card className="mt-4">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (slug.trim()) create.mutate(); }}>
            <div className="min-w-56 flex-1">
              <label htmlFor="slug" className="block text-sm font-medium">Slug</label>
              <input id="slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="anthology" className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-950" />
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Lowercase letters, digits and hyphens. It names the folder too.</p>
            </div>
            <Button type="submit" disabled={!slug.trim() || create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</Button>
          </form>
          {create.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{create.error.message}</p> : null}
        </Card>
      ) : null}

      {q.isPending ? <p className="mt-4" role="status">Loading projects…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load projects: {q.error.message}</p> : null}
      {q.data && q.data.length === 0 && !creating ? (
        <div className="mt-6">
          <EmptyState title="Projects hold what your agents make. Every version is kept."><Button onClick={() => setCreating(true)}>Create a project</Button></EmptyState>
        </div>
      ) : null}

      {q.data?.length ? (
        <ul className="mt-4 grid gap-3 md:grid-cols-2">
          {q.data.map((p) => (
            <li key={p.id}>
              <Card>
                <CardTitle><Link to={`/library/${p.slug}`} className="underline-offset-4 hover:underline">{p.name}</Link></CardTitle>
                <p className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-400">{p.slug}</p>
                {p.description ? <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{p.description}</p> : null}
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{p.documents} document{p.documents === 1 ? '' : 's'}</p>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ProjectDetail() {
  const { slug = '' } = useParams();
  const q = useQuery({ queryKey: ['documents', slug], queryFn: () => api.documents(slug), enabled: slug !== '' });

  return (
    <section aria-labelledby="screen-title">
      <p className="text-sm"><Link to="/library" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">← All projects</Link></p>
      <ScreenTitle className="mt-2">{slug}</ScreenTitle>
      <Prose className="mt-1">
        Export it from the command line: <code className="font-mono text-xs">workbench export project {slug} --out ./somewhere</code>
      </Prose>
      {q.isError ? <p role="alert" className="mt-3 text-red-700 dark:text-red-300">{q.error.message}</p> : null}
      <SpaceCard slug={slug} />
      {q.data && q.data.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="Nothing here yet. Run an agent with this project as its target and its output lands here.">
            <Button asChild variant="secondary"><Link to={`/agents?project=${encodeURIComponent(slug)}`}>Run an agent here</Link></Button>
          </EmptyState>
        </div>
      ) : null}
      {q.data?.length ? (
        // `table-fixed` plus a wrapping path: a document path is long and unbroken, and on a phone one of them
        // is enough to push the whole page sideways.
        <table className="mt-4 w-full table-fixed text-left text-sm">
          <caption className="sr-only">Documents in {slug}</caption>
          <thead>
            <tr className="border-b border-gray-200 text-gray-700 dark:border-gray-800 dark:text-gray-300">
              <th scope="col" className="w-1/2 py-2 pr-3 font-medium">Path</th>
              <th scope="col" className="w-16 py-2 pr-3 font-medium">Versions</th>
              <th scope="col" className="py-2 pr-3 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((d) => (
              <tr key={d.id} className="border-b border-gray-100 dark:border-gray-800">
                <td className="py-2 pr-3"><Link to={`/library/${slug}/${d.id}`} className="break-all font-mono text-xs text-blue-700 underline underline-offset-4 dark:text-sky-300">{d.path}</Link></td>
                <td className="py-2 pr-3">{d.versions}</td>
                <td className="py-2 pr-3">{d.updatedAt ? new Date(d.updatedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function DocumentView() {
  const { slug = '', id = '' } = useParams();
  const client = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['document', id], queryFn: () => api.document(id), enabled: id !== '' });
  const [draft, setDraft] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => { setDraft(null); setCompare(null); }, [id]);

  const save = useMutation({
    mutationFn: (content: string) => api.saveDocument(id, content),
    onSuccess: () => { setDraft(null); void client.invalidateQueries({ queryKey: ['document', id] }); void client.invalidateQueries({ queryKey: ['documents', slug] }); },
  });

  const diff = useQuery({
    queryKey: ['diff', id, compare?.from, compare?.to],
    queryFn: () => api.diff(id, compare!.from, compare!.to),
    enabled: compare !== null,
  });

  return (
    <section aria-labelledby="screen-title">
      <p className="text-sm"><Link to={`/library/${slug}`} className="text-blue-700 underline underline-offset-4 dark:text-sky-300">← {slug}</Link></p>
      <ScreenTitle className="mt-2"><span className="break-all font-mono text-lg">{q.data?.path ?? id}</span></ScreenTitle>
      {q.isError ? <p role="alert" className="mt-3 text-red-700 dark:text-red-300">{q.error.message}</p> : null}

      {q.data ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{draft === null ? 'Content' : 'Editing'}</CardTitle>
              {draft === null ? (
                <Button size="sm" variant="secondary" onClick={() => setDraft(q.data.content)}>Edit</Button>
              ) : (
                <>
                  <Button size="sm" onClick={() => save.mutate(draft)} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save as a new version'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                </>
              )}
            </div>
            {save.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{save.error.message}</p> : null}
            {draft === null ? (
              <pre tabIndex={0} className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-4 font-mono text-sm dark:bg-gray-950">{q.data.content}</pre>
            ) : (
              <>
                <label htmlFor="editor" className="sr-only">Document content</label>
                <textarea id="editor" rows={24} value={draft} onChange={(e) => setDraft(e.target.value)} className="mt-2 w-full rounded-md border border-gray-300 bg-white p-4 font-mono text-sm dark:border-gray-700 dark:bg-gray-950" />
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Saving keeps the current version and adds a new one. Nothing here is destructive.</p>
              </>
            )}
          </div>

          <div>
            <CardTitle>Versions</CardTitle>
            <ol className="mt-2 space-y-2">
              {[...q.data.history].reverse().map((v, i, all) => (
                <li key={v.id}>
                  <VersionRow
                    version={v}
                    isLatest={v.id === q.data.latestVersionId}
                    onCompare={all[i + 1] ? () => setCompare({ from: all[i + 1]!.id, to: v.id }) : undefined}
                    onView={() => navigate(`/library/${slug}/${id}`)}
                  />
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}

      {compare ? (
        <div className="mt-6">
          <div className="flex items-center gap-3">
            <SectionTitle>Diff</SectionTitle>
            <Button size="sm" variant="ghost" onClick={() => setCompare(null)}>Close</Button>
          </div>
          {diff.isPending ? <p role="status">Comparing…</p> : null}
          {diff.data ? (
            <>
              <p className="text-sm text-gray-700 dark:text-gray-300">{diff.data.added} line{diff.data.added === 1 ? '' : 's'} added, {diff.data.removed} removed.</p>
              <div className="mt-2 overflow-x-auto rounded border border-gray-200 dark:border-gray-800">
                <table className="w-full font-mono text-xs">
                  <caption className="sr-only">Line by line difference between the two versions</caption>
                  <tbody>
                    {diff.data.lines.map((line, i) => (
                      <tr key={i} className={line.kind === 'added' ? 'bg-green-50 dark:bg-green-900/40' : line.kind === 'removed' ? 'bg-red-50 dark:bg-red-900/40' : ''}>
                        <td className="w-10 select-none px-2 text-right text-gray-600 dark:text-gray-400">{line.leftNo ?? ''}</td>
                        <td className="w-10 select-none px-2 text-right text-gray-600 dark:text-gray-400">{line.rightNo ?? ''}</td>
                        <td className={line.kind === 'added' ? 'w-6 select-none px-1 font-semibold text-green-800 dark:text-green-300' : line.kind === 'removed' ? 'w-6 select-none px-1 font-semibold text-red-800 dark:text-red-300' : 'w-6 select-none px-1'}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</td>
                        <td className="whitespace-pre-wrap px-2 py-0.5">{line.text || ' '}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function VersionRow({ version, isLatest, onCompare }: { version: DocumentVersionSummary; isLatest: boolean; onCompare?: (() => void) | undefined; onView: () => void }) {
  return (
    <div className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={version.createdBy === 'human' ? 'busy' : 'neutral'}>{version.createdBy}</Badge>
        {isLatest ? <Badge tone="good">latest</Badge> : null}
        <time dateTime={version.createdAt} className="text-gray-700 dark:text-gray-300">{new Date(version.createdAt).toLocaleString()}</time>
      </div>
      {version.modelId ? <p className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-400">{version.modelId}</p> : null}
      {version.runId ? (
        <p className="mt-1 text-xs"><Link to={`/runs/${version.runId}`} className="text-blue-700 underline underline-offset-4 dark:text-sky-300">the run that made it</Link></p>
      ) : null}
      {onCompare ? <Button size="sm" variant="ghost" className="mt-2" onClick={onCompare}>Compare with the previous version</Button> : null}
    </div>
  );
}

/**
 * The project's space (D-69, RUN-18): its agents, its goals document, the ceiling on the tools any agent may use
 * here, and the memory scopes a run here retrieves. A form over `project.json`, saved hash-pinned: when the file
 * changed underneath, the save is refused and the form says so rather than overwriting.
 */
function SpaceCard({ slug }: { slug: string }) {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['space', slug], queryFn: () => api.space(slug), enabled: slug !== '' });
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, staleTime: 60_000 });
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.tools, staleTime: 60_000 });
  const [draft, setDraft] = useState<ProjectSpace | null>(null);
  const [said, setSaid] = useState('');
  const [conflict, setConflict] = useState<string | null>(null);
  const space = draft ?? q.data?.space ?? null;
  const dirty = draft !== null && q.data !== undefined && JSON.stringify(draft) !== JSON.stringify(q.data.space);

  const save = useMutation({
    mutationFn: () => api.saveSpace(slug, { space: draft ?? q.data!.space, baseVersion: q.data!.version }),
    onSuccess: (data) => {
      client.setQueryData(['space', slug], data);
      setDraft(null);
      setConflict(null);
      setSaid('Saved. The next run in this project reads it.');
    },
    onError: (e: Error) => {
      if (/changed since/.test(e.message)) setConflict(e.message);
      setSaid('');
    },
  });

  if (!q.data || !space) return q.isError ? <p role="alert" className="mt-3 text-red-700 dark:text-red-300">{q.error.message}</p> : null;
  const set = (patch: Partial<ProjectSpace>): void => setDraft({ ...space, ...patch });
  const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const check = 'h-6 w-6 md:h-4 md:w-4';

  return (
    <Card className="mt-6" data-testid="space">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Space</CardTitle>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            What a run in this project reads as: its agents, a goals page in every prompt, the tools any agent may use here, the memory it keeps.
            {q.data.exists ? '' : ' Nothing is set yet; the project is a folder and a target until you save.'}
          </p>
          {q.data.error ? <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">project.json does not load: {q.data.error}</p> : null}
        </div>
        <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save space'}</Button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="space-goals" className="block text-sm font-medium">Goals</label>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">A document in this project, read into every prompt of a run here, after the agent's own instructions.</p>
          <select id="space-goals" value={space.goals ?? ''} onChange={(e) => set(e.target.value ? { goals: e.target.value } : { goals: undefined })}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm dark:border-gray-700 dark:bg-gray-950">
            <option value="">None</option>
            {q.data.documents.map((d) => <option key={d} value={d}>{d}</option>)}
            {space.goals && !q.data.documents.includes(space.goals) ? <option value={space.goals}>{space.goals} (missing)</option> : null}
          </select>
        </div>

        <fieldset>
          <legend className="text-sm font-medium">Memory</legend>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">The scopes a run here retrieves and may write. Unticking one hides it from every agent working here.</p>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {(['agent', 'project', 'workspace', 'user'] as const).map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className={check} checked={space.memory.includes(scope)}
                  onChange={() => { const next = toggle(space.memory, scope); if (next.length) set({ memory: next as ProjectSpace['memory'] }); }} />
                {scope}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium">This project's agents</legend>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">First on this project's run forms. Naming an agent here grants it nothing.</p>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {(agents.data?.agents ?? []).map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className={check} checked={space.agents.includes(a.id)} onChange={() => set({ agents: toggle(space.agents, a.id) })} />
                {a.id}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium">Tools allowed here</legend>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">A ceiling, never a grant: a tool outside it is refused here by name, and one inside it still needs its grant on Tools.</p>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input type="checkbox" className={check} checked={space.tools !== undefined}
              onChange={(e) => set({ tools: e.target.checked ? [] : undefined })} />
            Limit the tools in this project
          </label>
          {space.tools !== undefined ? (
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {(tools.data?.tools ?? []).map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className={check} checked={space.tools!.includes(t.id)} onChange={() => set({ tools: toggle(space.tools!, t.id) })} />
                  <span className="font-mono text-xs">{t.id}</span>
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>
      </div>

      {conflict ? (
        <div role="alert" className="mt-4 rounded-md border-l-4 border-l-amber-600 bg-amber-50 p-3 text-sm dark:border-l-amber-400 dark:bg-amber-950">
          <p>{conflict}</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => { setDraft(null); setConflict(null); void client.invalidateQueries({ queryKey: ['space', slug] }); }}>Load what is on disk</Button>
        </div>
      ) : null}
      {save.isError && !conflict ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{save.error.message}</p> : null}
      <p role="status" aria-live="polite" className={said ? 'mt-3 text-sm text-gray-700 dark:text-gray-300' : 'sr-only'}>{said}</p>
      {dirty ? <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Unsaved.</p> : null}
    </Card>
  );
}
