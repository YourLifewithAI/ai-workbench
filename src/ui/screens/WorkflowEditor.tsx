// Editing a workflow as forms over its JSON (RUN-13, D-62). The graph is never drawn by hand: it re-renders
// from the draft on every keystroke, so an edge appears the moment a `{{steps.x.output}}` reference is typed,
// and the verdict shown live is the same function the runtime refuses a save with. The file is the truth: a
// save carries the hash the draft was loaded at, and a file that moved underneath is refused with the diff.
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { WorkflowConflict, WorkflowDetail, WorkflowIssue } from '../../shared/api/index.js';
import { referencesIn, type TemplateValue } from '../../shared/template.js';
import { parseExpr, rootsOf } from '../../shared/expr.js';
import { checkDefinition } from '../../shared/workflow-check.js';
import { validateWorkflow } from '../../shared/workflow.js';
import { api, ApiRequestError } from '../lib/api.js';
import { RunGraph, type GraphStep } from '../components/RunGraph.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Prose, ScreenTitle, SectionTitle, Subheading } from '../components/ui/text.js';

type Rec = Record<string, unknown>;
type StepDraft = Rec & { id: string; kind: string };
interface Draft extends Rec { id: string; name: string; description: string; defaultProject?: string; inputs: Rec; steps: StepDraft[]; outputs?: Rec }

const FIELD = 'mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm dark:border-gray-700 dark:bg-gray-950';
const MONO = `${FIELD} font-mono`;
const HINT = 'mt-0.5 text-xs text-gray-600 dark:text-gray-400';
const LABEL = 'block text-sm font-medium';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---- the live analysis -------------------------------------------------------------------------------------

interface Analysis { graph: GraphStep[]; issues: WorkflowIssue[]; smells: { stepId: string; message: string }[]; valid: boolean }

/** Steps a step refers to, read the way the validator reads them: templates, `when`, and a map's `over`. */
function referencedSteps(step: Rec): string[] {
  const out: string[] = [];
  const note = (r: { root: string; segments: (string | number)[] }): void => {
    if (r.root === 'steps' && typeof r.segments[1] === 'string') out.push(r.segments[1]);
  };
  const inner = step['kind'] === 'map' ? (step['step'] as Rec | undefined) : undefined;
  const templates = [step['input'], (step['output'] as Rec | undefined)?.['document'], inner?.['input'], (inner?.['output'] as Rec | undefined)?.['document']];
  for (const template of templates) {
    if (template === undefined || template === null) continue;
    try { for (const r of referencesIn(template as TemplateValue)) note(r); } catch { /* half-typed: no edge yet */ }
  }
  for (const source of [step['when'], step['over']]) {
    if (typeof source !== 'string' || !source.trim()) continue;
    try { for (const r of rootsOf(parseExpr(source))) note(r); } catch { /* half-typed: no edge yet */ }
  }
  return out;
}

/**
 * The graph is computed leniently, from whatever the draft says right now, so it keeps drawing while a field
 * is momentarily empty; the verdict is the strict one, shared with the runtime's write path.
 */
function analyse(draft: Draft): Analysis {
  const ids = new Set(draft.steps.map((s) => s.id));
  const graph: GraphStep[] = draft.steps.map((step) => {
    const deps = new Set<string>(Array.isArray(step['dependsOn']) ? (step['dependsOn'] as unknown[]).filter((d): d is string => typeof d === 'string') : []);
    for (const target of referencedSteps(step)) if (ids.has(target) && target !== step.id) deps.add(target);
    return { id: step.id, kind: step.kind, agent: step.kind === 'agent' ? str(step['agent']) || null : null, dependsOn: [...deps], review: step['review'] === 'blocking' ? 'blocking' : 'none' };
  });
  const checked = checkDefinition(draft);
  const smells = checked.definition ? validateWorkflow(checked.definition).smells : [];
  return { graph, issues: checked.issues, smells, valid: checked.definition !== null };
}

// ---- screens -----------------------------------------------------------------------------------------------

/** A new file: blank, or a copy. The editor opens on it next. */
export function WorkflowNew() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: api.workflows });
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [copyOf, setCopyOf] = useState('');
  const [start, setStart] = useState<'blank' | 'copy'>('blank');
  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const create = useMutation({
    mutationFn: () => api.createWorkflow({ id, name, ...(start === 'copy' && copyOf ? { copyOf } : {}) }),
    onSuccess: (detail) => {
      void client.invalidateQueries({ queryKey: ['workflows'] });
      client.setQueryData(['workflow', detail.id], detail);
      navigate(`/workflows/${detail.id}/edit`);
    },
  });

  return (
    <section aria-labelledby="screen-title">
      <p className="text-sm"><Link to="/workflows" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">← All workflows</Link></p>
      <ScreenTitle className="mt-2">New workflow</ScreenTitle>
      <Prose className="mt-1">
        This writes one file, <code className="font-mono">workflows/&lt;id&gt;.workflow.json</code>, and opens it in the editor.
      </Prose>
      <form className="mt-4 max-w-xl space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div>
          <label htmlFor="wf-name" className={LABEL}>Name</label>
          <input id="wf-name" required value={name} className={FIELD}
            onChange={(e) => { setName(e.target.value); if (!idTouched) setId(slug(e.target.value)); }} />
        </div>
        <div>
          <label htmlFor="wf-id" className={LABEL}>Id</label>
          <p id="wf-id-hint" className={HINT}>The file name: lowercase letters, digits and hyphens. It cannot change later.</p>
          <input id="wf-id" required pattern="[a-z0-9-]+" aria-describedby="wf-id-hint" value={id} className={MONO}
            onChange={(e) => { setIdTouched(true); setId(e.target.value); }} />
        </div>
        <fieldset>
          <legend className={LABEL}>Start from</legend>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input type="radio" name="start" className="h-6 w-6" checked={start === 'blank'} onChange={() => setStart('blank')} />
            Blank: one step, one input
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input type="radio" name="start" className="h-6 w-6" checked={start === 'copy'} onChange={() => setStart('copy')} />
            A copy of an existing workflow
          </label>
          {start === 'copy' ? (
            <div className="mt-2">
              <label htmlFor="wf-copy" className={LABEL}>Copy of</label>
              <p id="wf-copy-hint" className={HINT}>Its steps and inputs are copied; its schedule is not.</p>
              <select id="wf-copy" required aria-describedby="wf-copy-hint" value={copyOf} onChange={(e) => setCopyOf(e.target.value)} className={FIELD}>
                <option value="">Choose a workflow</option>
                {(workflows.data?.workflows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} ({w.id})</option>)}
              </select>
            </div>
          ) : null}
        </fieldset>
        {create.isError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{create.error.message}</p> : null}
        <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create workflow'}</Button>
      </form>
    </section>
  );
}

export function WorkflowEditor() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['workflow', id], queryFn: () => api.workflow(id), enabled: id !== '' });
  return (
    <section aria-labelledby="screen-title">
      <p className="text-sm"><Link to={`/workflows/${id}`} className="text-blue-700 underline underline-offset-4 dark:text-sky-300">← Back to the workflow</Link></p>
      {q.isPending ? <p className="mt-4" role="status">Loading…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load this workflow: {q.error.message}</p> : null}
      {/* Keyed by version: loading what is on disk after a conflict starts the editor over on that version. */}
      {q.data ? <Editor key={q.data.version} loaded={q.data} /> : null}
    </section>
  );
}

function Editor({ loaded }: { loaded: WorkflowDetail }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => clone(loaded.definition) as Draft);
  // A stable key per step row, kept beside the draft rather than in it: ids are editable, so they cannot key
  // the rows (each keystroke would remount the form), and nothing in the file may carry an editor artefact.
  const [keys, setKeys] = useState<number[]>(() => (loaded.definition['steps'] as unknown[]).map((_, i) => i));
  // The step forms are a list of headings with one open (L4): a six-step workflow is a screen, not a scroll.
  const [openStep, setOpenStep] = useState<number | null>(0);
  const nextKey = useRef(keys.length);
  const [baseVersion, setBaseVersion] = useState(loaded.version);
  const [conflict, setConflict] = useState<WorkflowConflict | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const analysis = useMemo(() => analyse(draft), [draft]);

  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, staleTime: 60_000 });
  const models = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 60_000 });
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.tools, staleTime: 60_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, staleTime: 60_000 });
  const agentIds = (agents.data?.agents ?? []).map((a) => a.id);
  const modelIds = (models.data?.models ?? []).map((m) => m.id);
  const toolIds = (tools.data?.tools ?? []).map((t) => t.id);

  const save = useMutation({
    mutationFn: (base: string) => api.saveWorkflow(loaded.id, { definition: draft, baseVersion: base }),
    onSuccess: (detail) => {
      void client.invalidateQueries({ queryKey: ['workflows'] });
      client.setQueryData(['workflow', loaded.id], detail);
      navigate(`/workflows/${loaded.id}`, { state: { saved: detail.version } });
    },
    onError: (e) => {
      const details = e instanceof ApiRequestError ? (e.details as { conflict?: WorkflowConflict } | undefined) : undefined;
      if (e instanceof ApiRequestError && e.code === 'conflict' && details?.conflict) { setConflict(details.conflict); setRefused(null); return; }
      setConflict(null);
      setRefused(e.message);
    },
  });

  const update = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));
  const updateStep = (index: number, step: StepDraft): void => setDraft((d) => ({ ...d, steps: d.steps.map((s, i) => (i === index ? step : s)) }));
  const swap = <T,>(list: T[], a: number, b: number): T[] => { const out = [...list]; [out[a], out[b]] = [out[b]!, out[a]!]; return out; };
  const moveStep = (index: number, by: -1 | 1): void => {
    const target = index + by;
    if (target < 0 || target >= draft.steps.length) return;
    setDraft((d) => ({ ...d, steps: swap(d.steps, index, target) }));
    setKeys((k) => swap(k, index, target));
    setOpenStep((o) => (o === index ? target : o === target ? index : o));
  };
  const removeStep = (index: number): void => {
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== index) }));
    setKeys((k) => k.filter((_, i) => i !== index));
    setOpenStep((o) => (o === null || o === index ? null : o > index ? o - 1 : o));
  };
  const addStep = (): void => {
    let n = draft.steps.length + 1;
    while (draft.steps.some((s) => s.id === `step-${n}`)) n++;
    setDraft((d) => ({ ...d, steps: [...d.steps, { id: `step-${n}`, kind: 'agent', agent: agentIds[0] ?? '', input: '' }] }));
    setKeys((k) => [...k, nextKey.current++]);
    setOpenStep(draft.steps.length);
  };

  const loadDisk = (): void => { void client.invalidateQueries({ queryKey: ['workflow', loaded.id] }); };

  return (
    <>
      <ScreenTitle className="mt-2">Edit {loaded.name}</ScreenTitle>
      <p className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-400">{loaded.file} · opened at {baseVersion.replace('sha256:', '').slice(0, 16)}</p>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <Card>
            <Subheading as="h2">The graph, as the draft reads now</Subheading>
            <p className={HINT}>Edges come from references: type <code className="font-mono">{'{{steps.x.output}}'}</code> in a step and watch it connect. Nothing here is draggable, because an edge you drew is a line the runtime would not read.</p>
            <div data-testid="draft-graph" className="mt-3">
              {analysis.graph.length ? <RunGraph steps={analysis.graph} /> : <p className="text-sm">No steps yet. Add the first one under Steps; it appears here as you type.</p>}
            </div>
          </Card>
          {analysis.issues.length ? (
            <Card className="border-l-4 border-l-red-600 dark:border-l-red-400" role="status" aria-live="polite" data-testid="draft-issues">
              <Subheading as="h2">This draft would not run</Subheading>
              <ul className="mt-1 space-y-1 text-sm">
                {analysis.issues.map((issue, i) => (
                  <li key={`${issue.path}-${i}`}>{issue.stepId ? <><span className="font-mono text-xs">{issue.stepId}</span> — </> : <><span className="font-mono text-xs">{issue.path}</span> — </>}{issue.message}</li>
                ))}
              </ul>
            </Card>
          ) : null}
          {analysis.smells.length ? (
            <Card className="border-l-4 border-l-amber-600 dark:border-l-amber-400" data-testid="draft-smells">
              <Subheading as="h2">Worth a look</Subheading>
              <ul className="mt-1 space-y-1 text-sm">
                {analysis.smells.map((s) => <li key={`${s.stepId}-${s.message}`}><span className="font-mono text-xs">{s.stepId}</span> — {s.message}</li>)}
              </ul>
              <p className={HINT}>Warnings, not errors. The draft can be saved either way.</p>
            </Card>
          ) : null}
        </div>

        <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); save.mutate(baseVersion); }} aria-label="Workflow editor">
          <Card className="space-y-3">
            <SectionTitle>The workflow</SectionTitle>
            <div>
              <label htmlFor="wf-name" className={LABEL}>Name</label>
              <input id="wf-name" value={draft.name} onChange={(e) => update({ name: e.target.value })} className={FIELD} />
            </div>
            <div>
              <label htmlFor="wf-description" className={LABEL}>Description</label>
              <textarea id="wf-description" rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} className={FIELD} />
            </div>
            <div>
              <label htmlFor="wf-project" className={LABEL}>Default project</label>
              <p id="wf-project-hint" className={HINT}>Where a run files what it produces, unless the run says otherwise.</p>
              <select id="wf-project" aria-describedby="wf-project-hint" value={draft.defaultProject ?? ''} className={FIELD}
                onChange={(e) => setDraft((d) => { const next = { ...d }; if (e.target.value) next.defaultProject = e.target.value; else delete next.defaultProject; return next; })}>
                <option value="">No project</option>
                {(projects.data ?? []).map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                {draft.defaultProject && !(projects.data ?? []).some((p) => p.slug === draft.defaultProject) ? <option value={draft.defaultProject}>{draft.defaultProject} (not in the Library yet)</option> : null}
              </select>
            </div>
            <InputsEditor inputs={draft.inputs} onChange={(inputs) => update({ inputs })} />
            <OutputsEditor outputs={(draft.outputs ?? {}) as Record<string, unknown>} onChange={(outputs) => update({ outputs })} />
          </Card>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>Steps</SectionTitle>
              <Button type="button" variant="secondary" size="sm" onClick={addStep}>Add a step</Button>
            </div>
            {draft.steps.map((step, index) => (
              <StepEditor
                key={keys[index] ?? index}
                step={step}
                index={index}
                count={draft.steps.length}
                stepIds={draft.steps.map((s) => s.id)}
                agentIds={agentIds}
                modelIds={modelIds}
                toolIds={toolIds}
                onChange={(next) => updateStep(index, next)}
                onMove={(by) => moveStep(index, by)}
                onRemove={() => removeStep(index)}
                open={openStep === index}
                onToggle={() => setOpenStep((o) => (o === index ? null : index))}
              />
            ))}
          </div>

          {conflict ? <ConflictPanel conflict={conflict} message={save.error?.message ?? ''} onLoadDisk={loadDisk} onOverwrite={() => { setBaseVersion(conflict.currentVersion); setConflict(null); save.mutate(conflict.currentVersion); }} onDismiss={() => setConflict(null)} /> : null}
          {refused ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{refused}</p> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={save.isPending || !analysis.valid}>{save.isPending ? 'Saving…' : 'Save workflow'}</Button>
            {!analysis.valid ? <p className="text-sm text-gray-700 dark:text-gray-300">Fix what is listed under <em>This draft would not run</em> to save.</p> : null}
            <Link to={`/workflows/${loaded.id}`} className="text-sm text-blue-700 underline underline-offset-4 dark:text-sky-300">Discard changes</Link>
          </div>
        </form>
      </div>
    </>
  );
}

// ---- the conflict ------------------------------------------------------------------------------------------

function ConflictPanel({ conflict, message, onLoadDisk, onOverwrite, onDismiss }: { conflict: WorkflowConflict; message: string; onLoadDisk: () => void; onOverwrite: () => void; onDismiss: () => void }) {
  // The changed lines with two of context on each side; a whole file of `same` lines hides the point.
  const lines = conflict.diff.lines;
  const keep = new Set<number>();
  lines.forEach((line, i) => { if (line.kind !== 'same') for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j); });
  return (
    <Card role="alert" className="border-l-4 border-l-red-600 dark:border-l-red-400" data-testid="conflict">
      <p className="font-medium">The file changed on disk since you opened it.</p>
      <p className="mt-1 text-sm">{message}</p>
      <p className={HINT}>
        {conflict.against === 'loaded' ? 'Lines marked − are the version you opened; + is what is on disk now.' : 'Lines marked − are your draft; + is what is on disk now.'}
      </p>
      <pre data-testid="conflict-diff" className="mt-2 max-h-80 overflow-auto rounded-md bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">
        {lines.map((line, i) => keep.has(i) ? (
          <div key={i} className={line.kind === 'added' ? 'text-green-800 dark:text-green-300' : line.kind === 'removed' ? 'text-red-800 dark:text-red-300' : 'text-gray-600 dark:text-gray-400'}>
            {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}{line.text}
          </div>
        ) : null)}
      </pre>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onLoadDisk}>Load what is on disk (discards this draft)</Button>
        <Button type="button" variant="secondary" size="sm" onClick={onOverwrite}>Save my draft over it</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>Keep editing</Button>
      </div>
    </Card>
  );
}

// ---- workflow-level editors --------------------------------------------------------------------------------

const TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'];

/** The `inputs` schema as rows. Keys the rows do not show (defaults, items, enums) travel with the property untouched. */
function InputsEditor({ inputs, onChange }: { inputs: Rec; onChange: (inputs: Rec) => void }) {
  const properties = (inputs['properties'] ?? {}) as Record<string, Rec>;
  const required = Array.isArray(inputs['required']) ? (inputs['required'] as string[]) : [];
  const names = Object.keys(properties);
  const write = (nextProps: Record<string, Rec>, nextRequired: string[]): void =>
    onChange({ ...inputs, type: 'object', properties: nextProps, required: nextRequired.filter((r) => r in nextProps) });
  const rename = (from: string, to: string): void => {
    const nextProps: Record<string, Rec> = {};
    for (const [k, v] of Object.entries(properties)) nextProps[k === from ? to : k] = v;
    write(nextProps, required.map((r) => (r === from ? to : r)));
  };
  const patch = (name: string, p: Rec): void => write({ ...properties, [name]: { ...properties[name], ...p } }, required);
  const setRequired = (name: string, on: boolean): void => write(properties, on ? [...new Set([...required, name])] : required.filter((r) => r !== name));
  const remove = (name: string): void => { const next = { ...properties }; delete next[name]; write(next, required); };
  const add = (): void => { let n = names.length + 1; while (`field${n}` in properties) n++; write({ ...properties, [`field${n}`]: { type: 'string', title: `Field ${n}` } }, [...required, `field${n}`]); };

  return (
    <fieldset>
      <legend className={LABEL}>Inputs</legend>
      <p className={HINT}>The run form is generated from these. A step reads one as <code className="font-mono">{'{{inputs.name}}'}</code>.</p>
      <div className="mt-2 space-y-2">
        {names.map((name) => {
          const spec = properties[name]!;
          return (
            <div key={name} className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor={`in-${name}-name`} className={LABEL}>Name</label>
                  <input id={`in-${name}-name`} defaultValue={name} className={MONO} onBlur={(e) => { const to = e.target.value.trim(); if (to && to !== name && !(to in properties)) rename(name, to); else e.target.value = name; }} />
                </div>
                <div>
                  <label htmlFor={`in-${name}-title`} className={LABEL}>Label</label>
                  <input id={`in-${name}-title`} value={str(spec['title'])} onChange={(e) => patch(name, { title: e.target.value })} className={FIELD} />
                </div>
                <div>
                  <label htmlFor={`in-${name}-type`} className={LABEL}>Type</label>
                  <select id={`in-${name}-type`} value={str(spec['type']) || 'string'} onChange={(e) => patch(name, { type: e.target.value })} className={FIELD}>
                    {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor={`in-${name}-description`} className={LABEL}>Hint</label>
                  <input id={`in-${name}-description`} value={str(spec['description'])} onChange={(e) => patch(name, { description: e.target.value })} className={FIELD} />
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-6 w-6" checked={required.includes(name)} onChange={(e) => setRequired(name, e.target.checked)} />
                  Required
                </label>
                <Button type="button" variant="ghost" size="sm" onClick={() => remove(name)}>Remove<span className="sr-only"> the input {name}</span></Button>
              </div>
            </div>
          );
        })}
      </div>
      <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={add}>Add an input</Button>
    </fieldset>
  );
}

/** What the run reports at the end: a name and the template it renders. */
function OutputsEditor({ outputs, onChange }: { outputs: Rec; onChange: (outputs: Rec) => void }) {
  const names = Object.keys(outputs);
  const rename = (from: string, to: string): void => { const next: Rec = {}; for (const [k, v] of Object.entries(outputs)) next[k === from ? to : k] = v; onChange(next); };
  return (
    <fieldset>
      <legend className={LABEL}>Outputs</legend>
      <p className={HINT}>What a finished run reports, by name. Usually <code className="font-mono">{'{{steps.last.output}}'}</code>.</p>
      <div className="mt-2 space-y-2">
        {names.map((name) => (
          <div key={name} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <div>
              <label htmlFor={`out-${name}-name`} className={LABEL}>Name</label>
              <input id={`out-${name}-name`} defaultValue={name} className={MONO} onBlur={(e) => { const to = e.target.value.trim(); if (to && to !== name && !(to in outputs)) rename(name, to); else e.target.value = name; }} />
            </div>
            <div>
              <label htmlFor={`out-${name}-template`} className={LABEL}>Template</label>
              {typeof outputs[name] === 'string' || outputs[name] === undefined
                ? <input id={`out-${name}-template`} value={str(outputs[name])} onChange={(e) => onChange({ ...outputs, [name]: e.target.value })} className={MONO} />
                : <JsonField id={`out-${name}-template`} value={outputs[name]} onChange={(v) => onChange({ ...outputs, [name]: v })} rows={3} />}
            </div>
            <div className="flex items-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => { const next = { ...outputs }; delete next[name]; onChange(next); }}>Remove<span className="sr-only"> the output {name}</span></Button>
            </div>
          </div>
        ))}
      </div>
      <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => { let n = names.length + 1; while (`output${n}` in outputs) n++; onChange({ ...outputs, [`output${n}`]: '' }); }}>Add an output</Button>
    </fieldset>
  );
}

// ---- one step ----------------------------------------------------------------------------------------------

interface StepEditorProps {
  step: StepDraft; index: number; count: number; stepIds: string[];
  agentIds: string[]; modelIds: string[]; toolIds: string[];
  onChange: (step: StepDraft) => void; onMove: (by: -1 | 1) => void; onRemove: () => void;
  /** One step is open at a time (L4); the rest are a heading, a summary and an Open button. */
  open: boolean;
  onToggle: () => void;
}

function StepEditor({ step, index, count, stepIds, agentIds, modelIds, toolIds, onChange, onMove, onRemove, open, onToggle }: StepEditorProps) {
  const id = `step-${index}`;
  const set = (patch: Rec): void => {
    const next: Rec = { ...step, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    onChange(next as StepDraft);
  };
  const setKind = (kind: string): void => {
    const common: StepDraft = { id: step.id, kind };
    for (const k of ['dependsOn', 'when', 'review', 'onReject', 'retries', 'budget']) if (step[k] !== undefined) common[k] = step[k];
    const agent = str(step['agent']) || (agentIds[0] ?? '');
    if (kind === 'agent') onChange({ ...common, agent, input: typeof step['input'] === 'string' ? step['input'] : '' });
    else if (kind === 'tool') onChange({ ...common, tool: str(step['tool']), input: typeof step['input'] === 'object' && step['input'] !== null ? step['input'] : {} });
    else onChange({ ...common, over: '', step: { id: 'item', kind: 'agent', agent, input: '{{item}}', output: { document: null } } });
  };
  const output = step['output'] as { document?: string | null } | undefined;
  const summary = step.kind === 'agent' ? `agent · ${str(step['agent']) || 'no agent yet'}`
    : step.kind === 'tool' ? `tool · ${str(step['tool']) || 'no tool yet'}`
    : `map over ${str(step['over']) || '…'}`;

  return (
    <fieldset className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900" data-testid={`step-${step.id}`}>
      <legend className="px-1 text-sm font-semibold">Step {step.id || `#${index + 1}`}</legend>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-700 dark:text-gray-300">{summary}{step['review'] === 'blocking' ? ' · waits for your review' : ''}</p>
        <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={onToggle}>
          {open ? 'Close' : 'Open'}<span className="sr-only"> step {step.id}</span>
        </Button>
      </div>
      {open ? <>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-id`} className={LABEL}>Step id</label>
          <input id={`${id}-id`} value={step.id} onChange={(e) => set({ id: e.target.value })} className={MONO} />
        </div>
        <div>
          <label htmlFor={`${id}-kind`} className={LABEL}>Kind</label>
          <select id={`${id}-kind`} value={step.kind} onChange={(e) => setKind(e.target.value)} className={FIELD}>
            <option value="agent">agent: a model with instructions</option>
            <option value="tool">tool: one tool call, no model</option>
            <option value="map">map: the same step over a list</option>
          </select>
        </div>

        {step.kind === 'agent' ? (
          <AgentFields id={id} step={step} agentIds={agentIds} modelIds={modelIds} set={set} />
        ) : null}

        {step.kind === 'tool' ? (
          <>
            <div>
              <label htmlFor={`${id}-tool`} className={LABEL}>Tool</label>
              <input id={`${id}-tool`} list="wb-tools" value={str(step['tool'])} onChange={(e) => set({ tool: e.target.value })} className={MONO} />
            </div>
            <div>
              <label htmlFor={`${id}-agent`} className={LABEL}>Runs under the grant of</label>
              <select id={`${id}-agent`} value={str(step['agent'])} onChange={(e) => set({ agent: e.target.value || undefined })} className={FIELD}>
                <option value="">the workflow&apos;s own</option>
                {agentIds.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={`${id}-input`} className={LABEL}>Input</label>
              <p className={HINT}>The tool&apos;s arguments as JSON; templates work inside the strings.</p>
              <JsonField id={`${id}-input`} value={step['input']} onChange={(v) => set({ input: v })} rows={4} />
            </div>
          </>
        ) : null}

        {step.kind === 'map' ? (
          <MapFields id={id} step={step} agentIds={agentIds} modelIds={modelIds} set={set} />
        ) : null}

        <div>
          <label htmlFor={`${id}-when`} className={LABEL}>Only when</label>
          <p className={HINT}>An expression; empty means always. <code className="font-mono">steps.plan.output.ok == true</code></p>
          <input id={`${id}-when`} value={str(step['when'])} onChange={(e) => set({ when: e.target.value || undefined })} className={MONO} />
        </div>
        <div>
          <label htmlFor={`${id}-review`} className={LABEL}>Review</label>
          <select id={`${id}-review`} value={step['review'] === 'blocking' ? 'blocking' : 'none'} onChange={(e) => set({ review: e.target.value === 'blocking' ? 'blocking' : undefined, ...(e.target.value === 'blocking' ? {} : { onReject: undefined }) })} className={FIELD}>
            <option value="none">Carry on</option>
            <option value="blocking">Wait for me before anything downstream runs</option>
          </select>
        </div>
        {step['review'] === 'blocking' ? (
          <div>
            <label htmlFor={`${id}-onReject`} className={LABEL}>If I reject, re-run</label>
            <select id={`${id}-onReject`} value={str(step['onReject'])} onChange={(e) => set({ onReject: e.target.value || undefined })} className={FIELD}>
              <option value="">this step</option>
              {stepIds.filter((s) => s && s !== step.id).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        ) : null}
        {step.kind !== 'map' ? (
          <div>
            <label htmlFor={`${id}-document`} className={LABEL}>File the output as</label>
            <p className={HINT}>A path in the project, templates allowed. Empty: the agent&apos;s own default.</p>
            <input id={`${id}-document`} value={str(output?.document)} disabled={output?.document === null}
              onChange={(e) => set({ output: e.target.value ? { ...output, document: e.target.value } : undefined })} className={MONO} />
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-6 w-6" checked={output?.document === null}
                onChange={(e) => set({ output: e.target.checked ? { document: null } : undefined })} />
              Keep it out of the Library (intermediate output)
            </label>
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={index === 0} onClick={() => onMove(-1)}>Move up<span className="sr-only"> {step.id}</span></Button>
        <Button type="button" variant="secondary" size="sm" disabled={index === count - 1} onClick={() => onMove(1)}>Move down<span className="sr-only"> {step.id}</span></Button>
        <Button type="button" variant="ghost" size="sm" disabled={count === 1} onClick={onRemove}>Remove<span className="sr-only"> {step.id}</span></Button>
      </div>
      <datalist id="wb-models">{modelIds.map((m) => <option key={m} value={m} />)}</datalist>
      <datalist id="wb-tools">{toolIds.map((t) => <option key={t} value={t} />)}</datalist>
      </> : null}
    </fieldset>
  );
}

function AgentFields({ id, step, agentIds, modelIds, set }: { id: string; step: Rec; agentIds: string[]; modelIds: string[]; set: (patch: Rec) => void }) {
  const agent = str(step['agent']);
  return (
    <>
      <div>
        <label htmlFor={`${id}-agent`} className={LABEL}>Agent</label>
        <select id={`${id}-agent`} value={agent} onChange={(e) => set({ agent: e.target.value })} className={FIELD}>
          {agent && !agentIds.includes(agent) ? <option value={agent}>{agent} (not in this workspace)</option> : null}
          {!agent ? <option value="">Choose an agent</option> : null}
          {agentIds.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-model`} className={LABEL}>Model</label>
        <p className={HINT}>Empty: the agent&apos;s own preference. Pin one to override it for this step.</p>
        <input id={`${id}-model`} list="wb-models" value={str(step['model'])} onChange={(e) => set({ model: e.target.value || undefined })} className={MONO} />
        {modelIds.length === 0 ? null : <span className="sr-only">{modelIds.length} models known</span>}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor={`${id}-input`} className={LABEL}>Input</label>
        <p className={HINT}>What the agent is given. <code className="font-mono">{'{{inputs.name}}'}</code> reads an input; <code className="font-mono">{'{{steps.x.output}}'}</code> reads a step and makes this one wait for it.</p>
        {typeof step['input'] === 'string' || step['input'] === undefined
          ? <textarea id={`${id}-input`} rows={4} value={str(step['input'])} onChange={(e) => set({ input: e.target.value })} className={MONO} />
          : <JsonField id={`${id}-input`} value={step['input']} onChange={(v) => set({ input: v })} rows={4} />}
      </div>
    </>
  );
}

function MapFields({ id, step, agentIds, modelIds, set }: { id: string; step: Rec; agentIds: string[]; modelIds: string[]; set: (patch: Rec) => void }) {
  const inner = (step['step'] ?? {}) as Rec;
  const setInner = (patch: Rec): void => {
    const next: Rec = { ...inner, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    set({ step: next });
  };
  const innerOutput = inner['output'] as { document?: string | null } | undefined;
  return (
    <>
      <div>
        <label htmlFor={`${id}-over`} className={LABEL}>Over</label>
        <p className={HINT}>An expression naming a list, one item per run. <code className="font-mono">steps.plan.output.questions</code></p>
        <input id={`${id}-over`} value={str(step['over'])} onChange={(e) => set({ over: e.target.value })} className={MONO} />
      </div>
      <div>
        <label htmlFor={`${id}-concurrency`} className={LABEL}>At a time</label>
        <input id={`${id}-concurrency`} type="number" min={1} max={20} value={typeof step['concurrency'] === 'number' ? step['concurrency'] : 3} onChange={(e) => set({ concurrency: Number(e.target.value) || 1 })} className={FIELD} />
      </div>
      <div className="sm:col-span-2 rounded-md border border-dashed border-gray-300 p-3 dark:border-gray-700">
        <p className="text-sm font-medium">For each item</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-inner-id`} className={LABEL}>Step id</label>
            <input id={`${id}-inner-id`} value={str(inner['id'])} onChange={(e) => setInner({ id: e.target.value })} className={MONO} />
          </div>
          <div>
            <label htmlFor={`${id}-inner-agent`} className={LABEL}>Agent</label>
            <select id={`${id}-inner-agent`} value={str(inner['agent'])} onChange={(e) => setInner({ agent: e.target.value })} className={FIELD}>
              {!str(inner['agent']) ? <option value="">Choose an agent</option> : null}
              {agentIds.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-inner-model`} className={LABEL}>Model</label>
            <input id={`${id}-inner-model`} list="wb-models" value={str(inner['model'])} onChange={(e) => setInner({ model: e.target.value || undefined })} className={MONO} />
            {modelIds.length === 0 ? null : <span className="sr-only">{modelIds.length} models known</span>}
          </div>
          <div>
            <label htmlFor={`${id}-inner-document`} className={LABEL}>File each output as</label>
            <input id={`${id}-inner-document`} value={str(innerOutput?.document)} disabled={innerOutput?.document === null}
              onChange={(e) => setInner({ output: e.target.value ? { document: e.target.value } : undefined })} className={MONO} />
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-6 w-6" checked={innerOutput?.document === null} onChange={(e) => setInner({ output: e.target.checked ? { document: null } : undefined })} />
              Keep them out of the Library
            </label>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-inner-input`} className={LABEL}>Input</label>
            <p className={HINT}><code className="font-mono">{'{{item}}'}</code> is the current item; <code className="font-mono">{'{{index}}'}</code> its position.</p>
            {typeof inner['input'] === 'string' || inner['input'] === undefined
              ? <textarea id={`${id}-inner-input`} rows={3} value={str(inner['input'])} onChange={(e) => setInner({ input: e.target.value })} className={MONO} />
              : <JsonField id={`${id}-inner-input`} value={inner['input']} onChange={(v) => setInner({ input: v })} rows={3} />}
          </div>
        </div>
      </div>
    </>
  );
}

/** A JSON value edited as text: the draft only changes when the text parses, and says so when it does not. */
function JsonField({ id, value, onChange, rows }: { id: string; value: unknown; onChange: (value: unknown) => void; rows: number }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea id={id} rows={rows} value={text} aria-invalid={bad} aria-describedby={bad ? `${id}-bad` : undefined} className={MONO}
        onChange={(e) => {
          setText(e.target.value);
          try { onChange(JSON.parse(e.target.value)); setBad(false); } catch { setBad(true); }
        }} />
      {bad ? <p id={`${id}-bad`} className="mt-0.5 text-xs text-red-700 dark:text-red-300">Not valid JSON yet; the draft keeps the last value that was.</p> : null}
    </>
  );
}
