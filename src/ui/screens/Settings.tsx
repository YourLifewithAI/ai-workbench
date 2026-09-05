import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { PluginStatusSummary } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { setWelcomeDone } from '../lib/welcome.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';
import { PushSettings } from '../components/PushSettings.js';

export function Settings() {
  const q = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const client = useQueryClient();
  const [said, setSaid] = useState('');
  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title" className="text-2xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        What this workspace is configured to do. Credentials are written to a 0600 file and are never shown back —
        not here, not through the API, not in a trace.
      </p>
      <p aria-live="polite" className="sr-only">{said}</p>
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
              <Row k="Deno sandbox" v={q.data.sandbox.deno ? 'available' : 'not installed — the execute tier is switched off'} />
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
          <div className="md:col-span-2"><Credentials configured={q.data.providersConfigured} onSaid={setSaid} onDone={() => void client.invalidateQueries({ queryKey: ['settings'] })} /></div>
          <div className="md:col-span-2"><PushSettings /></div>
          <div className="md:col-span-2"><Plugins plugins={q.data.plugins} onSaid={setSaid} onDone={() => void client.invalidateQueries({ queryKey: ['settings'] })} /></div>
          <div className="md:col-span-2">
            <Card>
              <h2 className="font-medium">MCP servers</h2>
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                Configured in <code className="font-mono">config/workbench.json</code> under <code className="font-mono">mcp.servers</code>.
                Their tools appear in the Tools screen, and a tool a server did not mark read-only asks you every time.
              </p>
              {q.data.mcpServers.length ? (
                <pre tabIndex={0} className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 font-mono text-xs dark:bg-gray-950">{JSON.stringify(q.data.mcpServers, null, 2)}</pre>
              ) : (
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">None configured.</p>
              )}
            </Card>
          </div>
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

/**
 * The credentials editor (SEC-05). A key goes in and never comes back: the API answers with the names that are
 * configured, so this screen can say *that* a provider has a key without being able to say what it is.
 */
function Credentials({ configured, onSaid, onDone }: { configured: string[]; onSaid: (text: string) => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const save = useMutation({
    mutationFn: (input: { name: string; apiKey: string | null }) => api.setCredential(input.name, input.apiKey),
    onSuccess: (_r, input) => {
      setName(''); setValue('');
      onSaid(input.apiKey === null ? `Removed the ${input.name} credential.` : `Saved the ${input.name} credential. It is in use now.`);
      onDone();
    },
  });

  return (
    <Card>
      <h2 className="font-medium">Credentials</h2>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        Written to <code className="font-mono">config/credentials.json</code> at mode 0600. Nothing reads them back out:
        what you see below is which names are set, and that is all this workbench can tell you.
      </p>

      <ul className="mt-3 space-y-1 text-sm">
        {configured.length === 0 ? <li className="text-gray-700 dark:text-gray-300">None configured. The mock provider needs none.</li> : null}
        {configured.map((provider) => (
          <li key={provider} className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs">{provider}</span>
            <span className="text-gray-600 dark:text-gray-400">set</span>
            <Button size="sm" variant="secondary" onClick={() => save.mutate({ name: provider, apiKey: null })} disabled={save.isPending}>Remove</Button>
          </li>
        ))}
      </ul>

      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        // The name is the prefix of the catalog ids the key unlocks, which are lowercase: `OpenAI` means `openai`.
        onSubmit={(e) => { e.preventDefault(); if (name.trim() && value.trim()) save.mutate({ name: name.trim().toLowerCase(), apiKey: value.trim() }); }}
      >
        <label className="block">
          <span className="block text-sm font-medium">Provider</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="google"
            className="mt-1 w-40 rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-950"
          />
        </label>
        <label className="block grow">
          <span className="block text-sm font-medium">Key</span>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            placeholder="pasted once, never shown again"
            className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-950"
          />
        </label>
        <Button type="submit" disabled={!name.trim() || !value.trim() || save.isPending}>Save</Button>
      </form>
      {save.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{save.error.message}</p> : null}
    </Card>
  );
}

/** Plugins (D-32). Trusted code, so the warning is the interface: nothing loads before someone has read it. */
function Plugins({ plugins, onSaid, onDone }: { plugins: PluginStatusSummary[]; onSaid: (text: string) => void; onDone: () => void }) {
  const trust = useMutation({
    mutationFn: (plugin: PluginStatusSummary) => api.trustPlugin(plugin.name, plugin.version),
    onSuccess: (result) => { onSaid(`${result.trusted} is trusted. Restart the runtime to load it.`); onDone(); },
  });

  return (
    <Card>
      <h2 className="font-medium">Plugins</h2>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        Code in <code className="font-mono">plugins/</code> that runs inside the workbench itself — not in the sandbox.
        Nothing loads until you have said so for that exact version.
      </p>
      {plugins.length === 0 ? (
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">No plugins in this workspace.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {plugins.map((plugin) => (
            <li key={`${plugin.name}@${plugin.version}`} className="border-t border-gray-100 pt-3 first:border-t-0 first:pt-0 dark:border-gray-800">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <Badge tone={plugin.loaded ? 'good' : plugin.acknowledged ? 'bad' : 'busy'}>
                  {plugin.loaded ? 'loaded' : plugin.acknowledged ? 'not loaded' : 'waiting for you'}
                </Badge>
                <span className="font-mono text-xs">{plugin.name}@{plugin.version}</span>
                <span className="text-xs text-gray-600 dark:text-gray-400">{plugin.kind}</span>
              </p>
              {plugin.description ? <p className="mt-1 text-sm">{plugin.description}</p> : null}
              {plugin.capabilities.length ? (
                <p className="mt-1 text-xs text-gray-700 dark:text-gray-300">it says it needs: <span className="font-mono">{plugin.capabilities.join(', ')}</span></p>
              ) : null}
              {plugin.error ? <p className="mt-1 text-sm text-red-700 dark:text-red-300">{plugin.error}</p> : null}
              {!plugin.acknowledged && plugin.version !== '?' ? (
                <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950">
                  <p className="text-sm">{plugin.warning}</p>
                  <Button className="mt-2" size="sm" onClick={() => trust.mutate(plugin)} disabled={trust.isPending}>
                    I trust this code — load it
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {trust.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{trust.error.message}</p> : null}
    </Card>
  );
}
