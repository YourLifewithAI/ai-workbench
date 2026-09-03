import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { setWelcomeDone } from '../lib/welcome.js';
import { Card } from '../components/ui/card.js';

export function Settings() {
  const q = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title" className="text-2xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Read-only for now; editing arrives in RUN-11. Change values in <code className="font-mono">config/workbench.json</code> and restart.</p>
      {q.isPending ? <p className="mt-4" role="status">Loading settings…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load settings: {q.error.message}</p> : null}
      {q.data ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Card>
            <h2 className="font-medium">Workspace</h2>
            <dl className="mt-2 text-sm">
              <Row k="Name" v={q.data.workspaceName} />
              <Row k="Path" v={q.data.workspacePath} mono />
              <Row k="Network mode" v={q.data.networkMode} />
              <Row k="Providers configured" v={q.data.providersConfigured.length ? q.data.providersConfigured.join(', ') : 'none (the mock provider needs no key)'} />
              <Row k="Deno sandbox" v={q.data.sandbox.deno ? 'available' : 'not found on PATH (needed from RUN-02)'} />
            </dl>
          </Card>
          <Card>
            <h2 className="font-medium">Budgets</h2>
            <dl className="mt-2 text-sm">{Object.entries(q.data.budgets).map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}</dl>
          </Card>
          <Card>
            <h2 className="font-medium">Execution</h2>
            <dl className="mt-2 text-sm">{Object.entries(q.data.execution).map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}</dl>
          </Card>
          <Card>
            <h2 className="font-medium">Retention</h2>
            <dl className="mt-2 text-sm">{Object.entries(q.data.retention).map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}</dl>
          </Card>
        </div>
      ) : null}
      <p className="mt-6 text-sm">
        <Link to="/welcome" onClick={() => setWelcomeDone(false)} className="text-blue-700 underline underline-offset-4 dark:text-sky-300">Show the welcome path again</Link>
      </p>
    </section>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b border-gray-100 py-1 last:border-b-0 dark:border-gray-800">
      <dt className="text-gray-600 dark:text-gray-400">{k}</dt>
      <dd className={mono ? 'break-all font-mono text-xs' : ''}>{v}</dd>
    </div>
  );
}
