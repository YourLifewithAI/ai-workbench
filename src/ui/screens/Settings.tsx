import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { PluginStatusSummary, SettingsResponse } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { setWelcomeDone } from '../lib/welcome.js';
import { Button } from '../components/ui/button.js';
import { Badge, Card } from '../components/ui/card.js';
import { PushSettings } from '../components/PushSettings.js';
import { CardTitle, Prose, ScreenTitle } from '../components/ui/text.js';

export function Settings() {
  const q = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const client = useQueryClient();
  const [said, setSaid] = useState('');
  return (
    <section aria-labelledby="screen-title">
      <ScreenTitle>Settings</ScreenTitle>
      <Prose className="mt-1">
        What this workspace is configured to do. Credentials are written to a 0600 file and are never shown back —
        not here, not through the API, not in a trace.
      </Prose>
      <p aria-live="polite" className="sr-only">{said}</p>
      {q.isPending ? <p className="mt-4" role="status">Loading settings…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load settings: {q.error.message}</p> : null}
      {q.data ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Card>
            <CardTitle>Workspace</CardTitle>
            <dl className="mt-2 text-sm">
              <Row k="Name" v={q.data.workspaceName} />
              <Row k="Path" v={q.data.workspacePath} mono />
              <Row k="Network mode" v={q.data.networkMode} />
              <Row k="Providers configured" v={q.data.providersConfigured.length ? q.data.providersConfigured.join(', ') : 'none (the mock provider needs no key)'} />
              <Row k="Deno sandbox" v={q.data.sandbox.deno ? 'available' : 'not installed — the execute tier is switched off'} />
            </dl>
          </Card>
          <Caps budgets={q.data.budgets} onSaid={setSaid} onDone={() => { void client.invalidateQueries({ queryKey: ['settings'] }); void client.invalidateQueries({ queryKey: ['dashboard'] }); }} />
          <Card>
            <CardTitle>Execution</CardTitle>
            <dl className="mt-2 text-sm">{Object.entries(q.data.execution).map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}</dl>
          </Card>
          <Card>
            <CardTitle>Retention</CardTitle>
            <dl className="mt-2 text-sm">{Object.entries(q.data.retention).map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}</dl>
          </Card>
          <div className="md:col-span-2"><Credentials configured={q.data.providersConfigured} onSaid={setSaid} onDone={() => void client.invalidateQueries({ queryKey: ['settings'] })} /></div>
          {q.data.models ? <div className="md:col-span-2"><ModelRoles key={JSON.stringify(q.data.models.roles)} models={q.data.models} onSaid={setSaid} onDone={() => { void client.invalidateQueries({ queryKey: ['settings'] }); void client.invalidateQueries({ queryKey: ['agents'] }); }} /></div> : null}
          <div className="md:col-span-2"><PushSettings /></div>
          <div className="md:col-span-2"><Plugins plugins={q.data.plugins} onSaid={setSaid} onDone={() => void client.invalidateQueries({ queryKey: ['settings'] })} /></div>
          <div className="md:col-span-2">
            <Card>
              <CardTitle>MCP servers</CardTitle>
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
      <CardTitle>Credentials</CardTitle>
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
      <CardTitle>Plugins</CardTitle>
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
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">it says it needs: <span className="font-mono">{plugin.capabilities.join(', ')}</span></p>
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

const AVAILABILITY_WORD: Record<string, string> = {
  ready: 'ready', 'no-credential': 'no key', 'blocked-by-mode': 'blocked by the network mode', unreachable: 'not answering',
  disabled: 'disabled', 'no-adapter': 'no adapter', 'price-unknown': 'price unknown',
};

/**
 * Which models do the work (D-68). A role is an ordered list; the first model in it that is ready runs. The
 * order is the owner's and is set here, never in an agent file: the shipped agents name roles, so a workspace
 * with one key runs on that key.
 */
function ModelRoles({ models, onSaid, onDone }: { models: NonNullable<SettingsResponse['models']>; onSaid: (text: string) => void; onDone: () => void }) {
  const catalog = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 30_000 });
  const [roles, setRoles] = useState<Record<string, string[]>>(() => ({ ...Object.fromEntries(models.undefinedRoles.map((r) => [r, []])), ...models.roles }));
  const [dirty, setDirty] = useState(false);
  const save = useMutation({
    mutationFn: () => api.updateSettings({ models: { roles } }),
    onSuccess: () => { setDirty(false); onSaid('Saved which models do the work.'); onDone(); },
  });
  const statusOf = (id: string): string => catalog.data?.models.find((m) => m.id === id)?.availability ?? 'unknown';
  const set = (name: string, list: string[]): void => { setRoles((r) => ({ ...r, [name]: list })); setDirty(true); };
  const move = (name: string, index: number, by: -1 | 1): void => {
    const list = [...(roles[name] ?? [])];
    const target = index + by;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target]!, list[index]!];
    set(name, list);
  };
  const names = Object.keys(roles).sort();
  const catalogIds = (catalog.data?.models ?? []).filter((m) => m.adapter !== 'mock').map((m) => m.id);

  return (
    <Card data-testid="model-roles">
      <CardTitle>Which models do the work</CardTitle>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        An agent names a role — <code className="font-mono">role:capable</code>, <code className="font-mono">role:fast</code>, <code className="font-mono">role:cheap</code> — instead of a model.
        The first model in the role&apos;s list that is ready is the one that runs, so the order here is the whole decision. A model pinned by id in an agent or a step still wins.
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {names.map((name) => {
          const list = roles[name] ?? [];
          const now = list.find((id) => statusOf(id) === 'ready') ?? null;
          return (
            <fieldset key={name} className="rounded-md border border-gray-200 p-3 dark:border-gray-800" data-testid={`role-${name}`}>
              <legend className="px-1 text-sm font-semibold"><span className="font-mono">role:{name}</span></legend>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {models.undefinedRoles.includes(name) && !list.length ? 'Named by an agent; no list yet. ' : ''}
                Now: <span className="font-mono">{now ?? 'nothing ready'}</span>
              </p>
              {list.length ? (
                <ol className="mt-2 space-y-1">
                  {list.map((id, index) => (
                    <li key={id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1 text-sm dark:bg-gray-950">
                      <span className="min-w-0 break-all"><span className="font-mono text-xs">{id}</span> <Badge tone={statusOf(id) === 'ready' ? 'good' : 'neutral'}>{AVAILABILITY_WORD[statusOf(id)] ?? statusOf(id)}</Badge></span>
                      <span className="flex gap-1">
                        <Button type="button" size="sm" variant="ghost" disabled={index === 0} onClick={() => move(name, index, -1)}>▲<span className="sr-only"> Move {id} up in {name}</span></Button>
                        <Button type="button" size="sm" variant="ghost" disabled={index === list.length - 1} onClick={() => move(name, index, 1)}>▼<span className="sr-only"> Move {id} down in {name}</span></Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => set(name, list.filter((x) => x !== id))}>×<span className="sr-only"> Remove {id} from {name}</span></Button>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">No models yet.</p>}
              <label htmlFor={`role-${name}-add`} className="mt-2 block text-xs font-medium">Add a model to {name}</label>
              <select id={`role-${name}-add`} value="" className="mt-1 w-full rounded-md border border-gray-300 bg-white p-1.5 text-sm dark:border-gray-700 dark:bg-gray-950"
                onChange={(e) => { if (e.target.value) set(name, [...list, e.target.value]); }}>
                <option value="">Choose a model</option>
                {catalogIds.filter((id) => !list.includes(id)).map((id) => <option key={id} value={id}>{id} ({AVAILABILITY_WORD[statusOf(id)] ?? statusOf(id)})</option>)}
              </select>
            </fieldset>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save models'}</Button>
        {save.isError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{save.error.message}</p> : null}
        {dirty ? <p className="text-sm text-gray-700 dark:text-gray-300">Unsaved.</p> : null}
      </div>
    </Card>
  );
}

/**
 * The three numbers that decide what a month can cost (F3), typed in on a screen: a run's cost cap, the day's,
 * the month's. The rest of the budgets block stays read-only here; it is about calls and clocks, not money.
 */
function Caps({ budgets, onSaid, onDone }: { budgets: Record<string, number>; onSaid: (text: string) => void; onDone: () => void }) {
  const [form, setForm] = useState({ maxCostUsd: String(budgets['maxCostUsd'] ?? ''), dailySpendCapUsd: String(budgets['dailySpendCapUsd'] ?? ''), monthlySpendCapUsd: String(budgets['monthlySpendCapUsd'] ?? '') });
  const save = useMutation({
    mutationFn: () => api.updateSettings({ budgets: { maxCostUsd: Number(form.maxCostUsd), dailySpendCapUsd: Number(form.dailySpendCapUsd), monthlySpendCapUsd: Number(form.monthlySpendCapUsd) } }),
    onSuccess: () => { onSaid('Saved the spending caps.'); onDone(); },
  });
  const field = (key: keyof typeof form, label: string, hint: string) => (
    <div>
      <label htmlFor={`cap-${key}`} className="block text-sm font-medium">{label}</label>
      <p id={`cap-${key}-hint`} className="text-xs text-gray-600 dark:text-gray-400">{hint}</p>
      <input id={`cap-${key}`} type="number" min={0} step="0.01" inputMode="decimal" aria-describedby={`cap-${key}-hint`} value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        className="mt-1 w-40 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm tabular-nums dark:border-gray-700 dark:bg-gray-950" />
    </div>
  );
  return (
    <Card data-testid="caps">
      <CardTitle>Budgets</CardTitle>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">Dollars. A run past its cap ends with a summary; a day or a month past its cap starts nothing new, and a used-up month pauses every schedule.</p>
      <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {field('maxCostUsd', 'Per run', 'The most one run may spend.')}
        {field('dailySpendCapUsd', 'Per day', '0 means no daily cap.')}
        {field('monthlySpendCapUsd', 'Per month', '0 means no monthly cap. Schedules pause when it is reached.')}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save caps'}</Button>
          {save.isError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{save.error.message}</p> : null}
        </div>
      </form>
      <dl className="mt-3 text-sm">{Object.entries(budgets).filter(([k]) => !['maxCostUsd', 'dailySpendCapUsd', 'monthlySpendCapUsd'].includes(k)).map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}</dl>
    </Card>
  );
}
