import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { DocumentVersionSummary } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';

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
        <h1 id="screen-title" className="text-2xl font-semibold">Library</h1>
        <Button variant="secondary" size="sm" onClick={() => setCreating((v) => !v)}>{creating ? 'Cancel' : 'New project'}</Button>
      </div>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Projects hold what your agents make. Every version is kept, with the run and model that produced it.</p>

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
                <h2 className="font-medium"><Link to={`/library/${p.slug}`} className="underline-offset-4 hover:underline">{p.name}</Link></h2>
                <p className="mt-1 font-mono text-xs text-gray-700 dark:text-gray-300">{p.slug}</p>
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
      <h1 id="screen-title" className="mt-2 text-2xl font-semibold">{slug}</h1>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Export it from the command line: <code className="font-mono text-xs">workbench export project {slug} --out ./somewhere</code>
      </p>
      {q.isError ? <p role="alert" className="mt-3 text-red-700 dark:text-red-300">{q.error.message}</p> : null}
      {q.data && q.data.length === 0 ? <div className="mt-6"><EmptyState title="Nothing here yet. Run an agent with this project as its target and its output lands here." /></div> : null}
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
      <h1 id="screen-title" className="mt-2 font-mono text-xl font-semibold">{q.data?.path ?? id}</h1>
      {q.isError ? <p role="alert" className="mt-3 text-red-700 dark:text-red-300">{q.error.message}</p> : null}

      {q.data ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">{draft === null ? 'Content' : 'Editing'}</h2>
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
            <h2 className="font-medium">Versions</h2>
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
            <h2 className="text-lg font-medium">Diff</h2>
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
                      <tr key={i} className={line.kind === 'added' ? 'bg-green-50 dark:bg-green-950' : line.kind === 'removed' ? 'bg-red-50 dark:bg-red-950' : ''}>
                        <td className="w-10 select-none px-2 text-right text-gray-600 dark:text-gray-400">{line.leftNo ?? ''}</td>
                        <td className="w-10 select-none px-2 text-right text-gray-600 dark:text-gray-400">{line.rightNo ?? ''}</td>
                        <td className="w-6 select-none px-1 text-gray-700 dark:text-gray-300">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</td>
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
      {version.modelId ? <p className="mt-1 font-mono text-xs text-gray-700 dark:text-gray-300">{version.modelId}</p> : null}
      {version.runId ? (
        <p className="mt-1 text-xs"><Link to={`/runs/${version.runId}`} className="text-blue-700 underline underline-offset-4 dark:text-sky-300">the run that made it</Link></p>
      ) : null}
      {onCompare ? <Button size="sm" variant="ghost" className="mt-2" onClick={onCompare}>Compare with the previous version</Button> : null}
    </div>
  );
}
