import { useMemo, useState } from 'react';
import { describeCron } from '../lib/cron';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ScheduleSummary, WorkflowDetail as WorkflowDetailShape } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/EmptyState.js';
import { RunGraph } from '../components/RunGraph.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';

export function Workflows() {
  const q = useQuery({ queryKey: ['workflows'], queryFn: api.workflows });
  const client = useQueryClient();
  const reload = useMutation({ mutationFn: api.reloadAgents, onSuccess: () => client.invalidateQueries({ queryKey: ['workflows'] }) });

  return (
    <section aria-labelledby="screen-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 id="screen-title" className="text-2xl font-semibold">Workflows</h1>
        <Button variant="secondary" size="sm" onClick={() => reload.mutate()} disabled={reload.isPending}>
          {reload.isPending ? 'Reloading…' : 'Reload from disk'}
        </Button>
      </div>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Workflows are <code className="font-mono">.workflow.json</code> files in <code className="font-mono">workflows/</code>. Each one is a graph of steps; a step names an agent and the model to run it on.
      </p>

      {q.isPending ? <p className="mt-4" role="status">Loading workflows…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load workflows: {q.error.message}</p> : null}

      {q.data?.errors.length ? (
        <div className="mt-4 space-y-2" role="alert">
          {q.data.errors.map((e) => (
            <Card key={e.id} className="border-l-4 border-l-red-600 dark:border-l-red-400">
              <p className="font-medium">{e.id} did not load.</p>
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{e.message}</p>
              <p className="mt-1 break-all font-mono text-xs text-gray-600 dark:text-gray-400">{e.file}</p>
            </Card>
          ))}
        </div>
      ) : null}

      {q.data && q.data.workflows.length === 0 && q.data.errors.length === 0 ? (
        <div className="mt-6"><EmptyState title="No workflows in this workspace yet. A workflow is one JSON file naming the steps and what each one gets." /></div>
      ) : null}

      {q.data?.workflows.length ? (
        <ul className="mt-4 grid gap-3">
          {q.data.workflows.map((w) => (
            <li key={w.id}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-medium">
                      <Link to={`/workflows/${w.id}`} className="underline-offset-4 hover:underline">{w.name}</Link>
                    </h2>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{w.description}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge>{w.id}</Badge>
                    <span className="font-mono text-xs text-gray-600 dark:text-gray-400" title="Content hash of the definition">{w.version.replace('sha256:', '').slice(0, 12)}</span>
                  </div>
                </div>
                <RunGraph className="mt-4" workflow={w} />
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** One workflow: its graph, the smells the validator found, and a run form generated from `inputs`. */
export function WorkflowDetail() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['workflow', id], queryFn: () => api.workflow(id), enabled: id !== '' });

  return (
    <section aria-labelledby="screen-title">
      <p className="text-sm"><Link to="/workflows" className="text-blue-700 underline underline-offset-4 dark:text-sky-300">← All workflows</Link></p>
      {q.isPending ? <p className="mt-4" role="status">Loading…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load this workflow: {q.error.message}</p> : null}
      {q.data ? (
        <>
          <h1 id="screen-title" className="mt-2 text-2xl font-semibold">{q.data.name}</h1>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{q.data.description}</p>
          <p className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-400">{q.data.file} · {q.data.version.replace('sha256:', '').slice(0, 16)}</p>

          <Card className="mt-4"><RunGraph workflow={q.data} /></Card>

          {q.data.smells.length ? (
            <div className="mt-4 space-y-2">
              <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">Worth a look</h2>
              {q.data.smells.map((s) => (
                <Card key={`${s.stepId}-${s.message}`} className="border-l-4 border-l-amber-600 dark:border-l-amber-400">
                  <p className="text-sm"><span className="font-mono text-xs">{s.stepId}</span> — {s.message}</p>
                </Card>
              ))}
              <p className="text-xs text-gray-600 dark:text-gray-400">These are warnings, not errors. The workflow runs either way; you know things the validator does not.</p>
            </div>
          ) : null}

          <RunForm workflow={q.data} />
          <Schedules workflow={q.data} />
        </>
      ) : null}
    </section>
  );
}

interface Field { name: string; type: string; title: string; description: string; required: boolean; initial: string }

/** The form is generated from the workflow's `inputs` schema, so it never drifts from what the run validates. */
function fieldsOf(schema: Record<string, unknown>): Field[] {
  const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  return Object.entries(properties).map(([name, spec]) => ({
    name,
    type: typeof spec['type'] === 'string' ? (spec['type'] as string) : 'string',
    title: typeof spec['title'] === 'string' ? (spec['title'] as string) : name,
    description: typeof spec['description'] === 'string' ? (spec['description'] as string) : '',
    required: required.includes(name),
    initial: spec['default'] === undefined ? '' : typeof spec['default'] === 'string' ? spec['default'] : JSON.stringify(spec['default']),
  }));
}

function RunForm({ workflow }: { workflow: WorkflowDetailShape }) {
  const fields = useMemo(() => fieldsOf(workflow.inputs), [workflow.inputs]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.initial])));
  const [project, setProject] = useState(workflow.defaultProject ?? '');
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, staleTime: 60_000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 60_000 });
  const navigate = useNavigate();
  // Default to whichever the workspace can actually do. With no key, a real run can only fail, and the
  // ten-minute path in the README goes through this form; with a key, a silently mocked run is a lie.
  const hasKey = (settings.data?.providersConfigured.length ?? 0) > 0;
  const [useMock, setUseMock] = useState<boolean | null>(null);
  const mock = useMock ?? !hasKey;

  const start = useMutation({
    mutationFn: () => {
      const inputs: Record<string, unknown> = {};
      for (const field of fields) {
        const raw = values[field.name] ?? '';
        if (raw === '' && !field.required) continue;
        // A string field is sent as typed; anything else is JSON, which is what the schema asked for.
        if (field.type === 'string') { inputs[field.name] = raw; continue; }
        try { inputs[field.name] = JSON.parse(raw); } catch { inputs[field.name] = raw; }
      }
      return api.createRun({ kind: 'workflow', id: workflow.id, inputs, ...(project ? { project } : {}), ...(mock ? { provider: 'mock' as const } : {}) });
    },
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });

  return (
    <form
      className="mt-6 max-w-2xl space-y-4"
      onSubmit={(e) => { e.preventDefault(); start.mutate(); }}
      aria-labelledby="run-form-title"
    >
      <h2 id="run-form-title" className="text-lg font-semibold">Run it</h2>
      {fields.map((field) => (
        <div key={field.name}>
          <label htmlFor={`in-${field.name}`} className="block text-sm font-medium">
            {field.title}{field.required ? <span aria-hidden="true"> *</span> : null}
            {field.required ? <span className="sr-only"> (required)</span> : null}
          </label>
          {field.description ? <p id={`hint-${field.name}`} className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{field.description}</p> : null}
          <textarea
            id={`in-${field.name}`}
            required={field.required}
            rows={field.type === 'string' ? 3 : 2}
            aria-describedby={field.description ? `hint-${field.name}` : undefined}
            value={values[field.name] ?? ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 font-sans text-sm dark:border-gray-700 dark:bg-gray-950"
          />
        </div>
      ))}
      <div>
        <label htmlFor="in-project" className="block text-sm font-medium">Project</label>
        <p id="hint-project" className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">Where this run files what it produces.</p>
        <select
          id="in-project"
          aria-describedby="hint-project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className="mt-1 rounded-md border border-gray-300 bg-white p-2 text-sm dark:border-gray-700 dark:bg-gray-950"
        >
          <option value="">No project</option>
          {(projects.data ?? []).map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        {/* 24px is the smallest target WCAG 2.2 accepts. */}
        <input type="checkbox" checked={mock} onChange={(e) => setUseMock(e.target.checked)} className="h-6 w-6" />
        Use the mock provider (free, no key)
      </label>
      {!mock && !hasKey ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          No provider key is configured, so a real run will fail at its first model call. Add one in{' '}
          <Link to="/settings" className="underline underline-offset-4">Settings</Link>, or leave the mock ticked.
        </p>
      ) : null}
      {start.isError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{start.error.message}</p> : null}
      <Button type="submit" disabled={start.isPending}>{start.isPending ? 'Starting…' : 'Start run'}</Button>
    </form>
  );
}

/** Common shapes, so the usual schedule is a click rather than five fields of cron the owner has to remember. */
const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 07:00', cron: '0 7 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Every Monday at 08:00', cron: '0 8 * * 1' },
];

function Schedules({ workflow }: { workflow: WorkflowDetailShape }) {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['schedules'], queryFn: api.schedules });
  const mine = (q.data ?? []).filter((s) => s.workflowId === workflow.id);
  const [cron, setCron] = useState(PRESETS[1]!.cron);
  const [catchUp, setCatchUp] = useState<'none' | 'once'>('none');

  const invalidate = (): void => { void client.invalidateQueries({ queryKey: ['schedules'] }); };
  const add = useMutation({
    mutationFn: () => api.upsertSchedule({ workflowId: workflow.id, cron, catchUp, ...(workflow.defaultProject ? { project: workflow.defaultProject } : {}) }),
    onSuccess: invalidate,
  });
  const toggle = useMutation({
    mutationFn: (s: ScheduleSummary) => api.upsertSchedule({ workflowId: s.workflowId, cron: s.cron, inputs: s.inputs, catchUp: s.catchUp, enabled: !s.enabled, ...(s.project ? { project: s.project } : {}) }, s.id),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.removeSchedule(id), onSuccess: invalidate });

  return (
    <section className="mt-8 max-w-2xl" aria-labelledby="schedule-title">
      <h2 id="schedule-title" className="text-lg font-semibold">Schedule it</h2>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        A scheduled run is an ordinary run: it appears on the Dashboard and in Runs, and it is bounded by the same budgets.
      </p>

      {mine.length ? (
        <ul className="mt-3 space-y-2">
          {mine.map((s) => (
            <li key={s.id}>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm"><span title={s.cron}>{describeCron(s.cron)}</span> {s.enabled ? '' : '(paused)'}</p>
                    <p className="mt-0.5 text-xs text-gray-700 dark:text-gray-300">
                      Next {s.nextFireAt ? new Date(s.nextFireAt).toLocaleString() : 'never'} · missed windows: {s.catchUp === 'once' ? 'one catch-up run' : 'skipped'}
                      {s.seededFromFile ? ' · first set by the workflow file' : ''}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => toggle.mutate(s)} disabled={toggle.isPending}>
                      {s.enabled ? 'Pause' : 'Resume'}<span className="sr-only"> the {describeCron(s.cron)} schedule</span>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)} disabled={remove.isPending}>
                      Delete<span className="sr-only"> the {s.cron} schedule</span>
                    </Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">Not scheduled.</p>
      )}

      <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <div>
          <label htmlFor="cron" className="block text-sm font-medium">When</label>
          <p id="cron-hint" className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">Five fields, minute first, in this machine&apos;s time zone.</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <input
              id="cron"
              value={cron}
              aria-describedby="cron-hint"
              onChange={(e) => setCron(e.target.value)}
              className="rounded-md border border-gray-300 bg-white p-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-950"
            />
            {PRESETS.map((p) => (
              <Button key={p.cron} type="button" size="sm" variant="secondary" onClick={() => setCron(p.cron)}>{p.label}</Button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="catch-up" className="block text-sm font-medium">If the runtime was down</label>
          <select
            id="catch-up"
            value={catchUp}
            onChange={(e) => setCatchUp(e.target.value as 'none' | 'once')}
            className="mt-1 rounded-md border border-gray-300 bg-white p-2 text-sm dark:border-gray-700 dark:bg-gray-950"
          >
            <option value="none">Skip what was missed</option>
            <option value="once">Run once to catch up</option>
          </select>
        </div>
        {add.isError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{add.error.message}</p> : null}
        <Button type="submit" disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add schedule'}</Button>
      </form>
    </section>
  );
}
