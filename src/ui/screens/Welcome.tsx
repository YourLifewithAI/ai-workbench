import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { setWelcomeDone } from '../lib/welcome.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { useRunExample } from './Runs.js';

/** The guided first run (D-56): four steps, one action each, each with a "why" line. */
export function Welcome() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [provider, setProvider] = useState<'mock' | null>(null);
  const example = useRunExample();
  const navigate = useNavigate();
  const runId = example.data?.runId ?? null;

  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title" className="text-2xl font-semibold">Welcome</h1>
      <p className="mt-1 text-gray-700 dark:text-gray-300">Four steps and you will have watched an agent run and read exactly what it was told. Nothing here needs a key or a network connection.</p>

      <ol className="mt-6 space-y-4">
        <Step n={1} title="Your workspace" done={settings.isSuccess} why="Everything private (config, agents, runs, memory) lives in one directory you own. Back it up like any other folder.">
          {settings.isPending ? <p role="status">Reading settings…</p> : null}
          {settings.isError ? <p role="alert" className="text-red-700 dark:text-red-300">{settings.error.message}</p> : null}
          {settings.data ? <p><span className="font-medium">{settings.data.workspaceName}</span> <span className="break-all font-mono text-xs text-gray-600 dark:text-gray-400">{settings.data.workspacePath}</span></p> : null}
        </Step>

        <Step n={2} title="Pick a provider" done={provider !== null} why="Models are a replaceable substrate: an agent names a policy, not a vendor. The mock answers from scripted fixtures, so you can learn the workbench before you spend a cent.">
          {settings.data?.providersConfigured.length ? (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Configured: <span className="font-medium">{settings.data.providersConfigured.join(', ')}</span>. Real runs will use your agents&apos; model policies.
            </p>
          ) : (
            <details className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800">
              <summary className="cursor-pointer font-medium">Add a provider key</summary>
              <p className="mt-2 text-gray-700 dark:text-gray-300">
                Keys live in one file that only you can read, never in an agent and never in this page. Create
                <code className="mx-1 font-mono text-xs">config/credentials.json</code> in your workspace:
              </p>
              <pre tabIndex={0} className="mt-2 overflow-x-auto rounded bg-gray-50 p-3 font-mono text-xs dark:bg-gray-950">{'{ "google": { "apiKey": "…" } }'}</pre>
              <p className="mt-2 text-gray-700 dark:text-gray-300">
                Then <code className="font-mono text-xs">chmod 600</code> it and restart the runtime. The workbench refuses to read it at any looser permission, and redacts the value from every trace, log, and response.
              </p>
            </details>
          )}
          <Button className="mt-3" variant={provider === 'mock' ? 'secondary' : 'default'} onClick={() => setProvider('mock')} aria-pressed={provider === 'mock'}>
            {provider === 'mock' ? 'Using the mock provider' : 'Try it with the mock'}
          </Button>
        </Step>

        <Step n={3} title="Run the example agent" done={runId !== null} why="The echo agent replies with exactly what it was asked. It exists so the first run is about the workbench, not the model.">
          <Button onClick={() => example.mutate()} disabled={example.isPending || runId !== null}>
            {example.isPending ? 'Starting…' : runId ? 'Started' : 'Run the echo agent'}
          </Button>
          {example.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{example.error.message}</p> : null}
          {runId ? <p className="mt-2 text-sm">Run <span className="font-mono text-xs">{runId}</span> started.</p> : null}
        </Step>

        <Step n={4} title="Read its trace" done={false} why="Every run keeps every event: the compiled prompt, the response, the cost. Debugging a run is reading this file.">
          {runId ? (
            <Button onClick={() => { setWelcomeDone(true); navigate(`/runs/${runId}`); }}>Open the trace</Button>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400">Run the example first.</p>
          )}
        </Step>
      </ol>

      <p className="mt-8 text-sm text-gray-600 dark:text-gray-400">
        Already know your way around? <Link to="/runs" onClick={() => setWelcomeDone(true)} className="text-blue-700 underline underline-offset-4 dark:text-sky-300">Skip to Runs</Link>. You can reopen this path from Settings.
      </p>
    </section>
  );
}

function Step({ n, title, why, done, children }: { n: number; title: string; why: string; done: boolean; children: React.ReactNode }) {
  return (
    <li>
      <Card>
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-sm font-semibold dark:bg-gray-800">{done ? '✓' : n}</span>
          <div className="min-w-0 flex-1">
            <h2 className="font-medium">
              <span className="sr-only">Step {n}{done ? ', done' : ''}: </span>
              {title}
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{why}</p>
            <div className="mt-3">{children}</div>
          </div>
        </div>
      </Card>
    </li>
  );
}
