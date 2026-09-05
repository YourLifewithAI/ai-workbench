// Built-ins, the tool × agent grant matrix, and the denials that have actually happened (ui.md §Tools). The
// matrix is the authority: what an agent's own file asks for is shown next to it, and is not the same thing.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { AgentGrantSummary, GrantCell } from '../../shared/api/index.js';
import { api } from '../lib/api.js';
import { Badge, Card } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';

const NET_MODE_NOTE: Record<string, string> = {
  offline: 'no tool reaches the network',
  'local-only': 'only addresses on this machine',
  allowlist: 'only the hosts listed below',
  unrestricted: 'any public host; private addresses are still refused',
};

const TIER_NOTE: Record<string, string> = {
  read: 'reads something',
  write: 'changes something',
  execute: 'runs code',
};

export function Tools() {
  const q = useQuery({ queryKey: ['tools'], queryFn: api.tools });
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, staleTime: 60_000 });
  const client = useQueryClient();
  const setGrant = useMutation({
    mutationFn: (body: { agentId: string; toolId: string; grant: 'allow' | 'deny' | 'unset' }) => api.setGrant(body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['tools'] }),
  });

  const cellFor = (agentId: string, toolId: string): GrantCell | undefined =>
    q.data?.matrix.find((m) => m.agentId === agentId && m.toolId === toolId);

  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title" className="text-2xl font-semibold">Tools</h1>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        Tools are denied until you grant them. What an agent asks for in its own file is a request; this table is the answer.
      </p>

      {q.isPending ? <p className="mt-4" role="status">Loading…</p> : null}
      {q.isError ? <p className="mt-4 text-red-700 dark:text-red-300" role="alert">Could not load tools: {q.error.message}</p> : null}

      {q.data ? (
        <>
          <h2 className="mt-6 text-lg font-medium">Who may use what</h2>
          <div className="mt-2 overflow-x-auto" tabIndex={0}>
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The tool by agent grant matrix. Each cell allows, denies, or leaves a tool unset for one agent.</caption>
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800">
                  <th scope="col" className="py-2 pr-3 font-medium">Tool</th>
                  {(agents.data?.agents ?? []).map((a) => (
                    <th key={a.id} scope="col" className="py-2 pr-3 font-medium">{a.id}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.tools.map((tool) => (
                  <tr key={tool.id} className="border-b border-gray-100 align-top dark:border-gray-800">
                    <th scope="row" className="py-2 pr-3 font-normal">
                      <span className="font-mono text-xs">{tool.id}</span>
                      <span className="ml-2 text-xs text-gray-700 dark:text-gray-300">{TIER_NOTE[tool.tier]}</span>
                      {tool.approvalByDefault ? <Badge tone="busy" className="ml-2">always asks</Badge> : null}
                      {tool.usesNetwork ? <Badge tone="busy" className="ml-2">leaves the machine</Badge> : null}
                      {tool.origin?.kind === 'mcp' ? <Badge className="ml-2">{tool.origin.server}</Badge> : null}
                      {!tool.available ? <Badge tone="bad" className="ml-2">no sandbox</Badge> : null}
                    </th>
                    {(agents.data?.agents ?? []).map((agent) => {
                      const cell = cellFor(agent.id, tool.id);
                      const granted = cell?.granted ?? 'unset';
                      return (
                        <td key={agent.id} className="py-2 pr-3">
                          <label className="block">
                            <span className="sr-only">{tool.id} for {agent.id}</span>
                            <select
                              value={granted}
                              onChange={(e) => setGrant.mutate({ agentId: agent.id, toolId: tool.id, grant: e.target.value as 'allow' })}
                              className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-950"
                            >
                              <option value="unset">— denied</option>
                              <option value="allow">allow</option>
                              <option value="deny">deny always</option>
                            </select>
                          </label>
                          {cell?.requested && granted === 'unset' ? (
                            <span className="mt-0.5 block text-xs text-amber-800 dark:text-amber-300">asks for it</span>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {setGrant.isError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{setGrant.error.message}</p> : null}

          <h2 className="mt-8 text-lg font-medium">What can run code</h2>
          <Card className="mt-2" data-testid="sandbox-status">
            {q.data.sandbox.available ? (
              <>
                <p className="text-sm">
                  <Badge tone="good">sandbox available</Badge>{' '}
                  Code runs in Deno with no network and no filesystem beyond what an agent was granted. A script reaches
                  its tools through the bridge, where every check still applies.
                </p>
                <p className="mt-2 text-xs text-gray-700 dark:text-gray-300">
                  <span className="font-mono">{q.data.sandbox.path}</span> · stopped after{' '}
                  {Math.round(q.data.sandbox.limits.wallClockMs / 1000)}s, {q.data.sandbox.limits.memoryMb} MB, or{' '}
                  {Math.round(q.data.sandbox.limits.maxOutputBytes / 1024)} KB of output
                </p>
              </>
            ) : (
              <>
                <p className="text-sm">
                  <Badge tone="bad">no sandbox</Badge>{' '}
                  Deno is not installed, so nothing can be executed. These tools exist and cannot run:{' '}
                  <span className="font-mono text-xs">{q.data.sandbox.disabled.join(', ') || 'none'}</span>.
                </p>
                <p className="mt-2 text-xs text-gray-700 dark:text-gray-300">
                  Install Deno (deno.land) and restart. There is no unsandboxed fallback: running a model's code in this
                  process would be the thing the sandbox exists to prevent.
                </p>
              </>
            )}
          </Card>

          {q.data.mcpServers.length ? (
            <>
              <h2 className="mt-8 text-lg font-medium">MCP servers</h2>
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                Tools from outside this workbench. They are granted in the same table as the built-ins, and a tool the
                server did not mark read-only asks you every time.
              </p>
              <ul className="mt-2 space-y-2">
                {q.data.mcpServers.map((server) => (
                  <li key={server.name}>
                    <Card>
                      <p className="text-sm">
                        <Badge tone={server.running ? 'good' : 'bad'}>{server.running ? 'running' : 'not running'}</Badge>{' '}
                        <span className="font-mono text-xs">{server.name}</span>
                        {server.serverInfo?.name ? <span className="ml-2 text-gray-600 dark:text-gray-400">{server.serverInfo.name} {server.serverInfo.version ?? ''}</span> : null}
                      </p>
                      {server.error ? <p className="mt-1 text-sm text-red-700 dark:text-red-300">{server.error}</p> : null}
                      {server.tools.length ? (
                        <p className="mt-1 text-xs text-gray-700 dark:text-gray-300">
                          <span className="font-mono">{server.tools.join(', ')}</span>
                        </p>
                      ) : null}
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h2 className="mt-8 text-lg font-medium">Where they may go</h2>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            A granted network tool still only reaches what the policy allows. This is the policy as the fetch path
            computes it: the workspace's, narrowed by each agent's own.
          </p>
          <Card className="mt-2">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-gray-700 dark:text-gray-300">Workspace</dt>
              <dd><span className="font-mono text-xs">{q.data.network.mode}</span>{NET_MODE_NOTE[q.data.network.mode] ? <span className="ml-2 text-gray-700 dark:text-gray-300">{NET_MODE_NOTE[q.data.network.mode]}</span> : null}</dd>
              <dt className="text-gray-700 dark:text-gray-300">Allowed hosts</dt>
              <dd>{q.data.network.allow.length ? <span className="font-mono text-xs break-all">{q.data.network.allow.join(', ')}</span> : <span className="text-gray-700 dark:text-gray-300">none listed</span>}</dd>
              <dt className="text-gray-700 dark:text-gray-300">Local addresses</dt>
              <dd>{q.data.network.allowLocalAddresses ? 'reachable' : 'refused, including anything DNS resolves to one'}</dd>
              <dt className="text-gray-700 dark:text-gray-300">Sends without asking</dt>
              <dd>{q.data.network.approvalExempt.length ? <span className="font-mono text-xs break-all">{q.data.network.approvalExempt.join(', ')}</span> : <span className="text-gray-700 dark:text-gray-300">nowhere: a send that carries private data asks you first</span>}</dd>
              <dt className="text-gray-700 dark:text-gray-300">Search</dt>
              <dd className="font-mono text-xs">{q.data.network.searchProvider}</dd>
            </dl>
          </Card>
          <div className="mt-2 overflow-x-auto" tabIndex={0}>
            <table className="w-full text-left text-sm" data-testid="network-agents">
              <caption className="sr-only">The effective network policy for each agent</caption>
              <thead>
                <tr className="border-b border-gray-200 text-gray-700 dark:border-gray-800 dark:text-gray-300">
                  <th scope="col" className="py-2 pr-3 font-medium">Agent</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Network tools</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Mode</th>
                  <th scope="col" className="py-2 pr-3 font-medium">May reach</th>
                </tr>
              </thead>
              <tbody>
                {q.data.network.agents.map((agent) => (
                  <tr key={agent.agentId} className="border-b border-gray-100 dark:border-gray-800">
                    <th scope="row" className="py-2 pr-3 font-normal">{agent.agentId}</th>
                    <td className="py-2 pr-3">
                      {agent.tools.length
                        ? <span className="font-mono text-xs break-all">{agent.tools.join(', ')}</span>
                        : <span className="text-gray-700 dark:text-gray-300">none granted</span>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{agent.mode}</td>
                    <td className="py-2 pr-3">
                      {/* The policy is only half the answer: an agent with no network tool has no way out at all. */}
                      {agent.tools.length === 0
                        ? <span className="text-gray-700 dark:text-gray-300">nothing: it has no way out</span>
                        : agent.mode === 'offline'
                          ? <span className="text-gray-700 dark:text-gray-300">nothing</span>
                          : agent.mode === 'unrestricted'
                            ? <span className="text-gray-700 dark:text-gray-300">anything public</span>
                            : agent.allow.length
                              ? <span className="font-mono text-xs break-all">{agent.allow.join(', ')}</span>
                              : <span className="text-gray-700 dark:text-gray-300">nothing: the allowlist is empty</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mt-8 text-lg font-medium">What they may reach on disk</h2>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            The other half of a grant: the workspace paths an agent may read and write, and the repositories it may
            edit on a branch. A repository tool works only inside a granted checkout and only on the branches named
            here; nothing an agent does there reaches <span className="font-mono text-xs">main</span> without a person
            merging it. These are written by you, in <span className="font-mono text-xs">config/workbench.json</span>.
          </p>
          <div className="mt-2 overflow-x-auto" tabIndex={0}>
            <table className="w-full text-left text-sm" data-testid="disk-grants">
              <caption className="sr-only">Paths and repositories granted to each agent</caption>
              <thead>
                <tr className="border-b border-gray-200 text-gray-700 dark:border-gray-800 dark:text-gray-300">
                  <th scope="col" className="py-2 pr-3 font-medium">Agent</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Reads</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Writes</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Repositories</th>
                </tr>
              </thead>
              <tbody>
                {q.data.grants.map((grant) => (
                  <tr key={grant.agentId} className="border-b border-gray-100 align-top dark:border-gray-800">
                    <th scope="row" className="py-2 pr-3 font-normal">{grant.agentId}</th>
                    <td className="py-2 pr-3">
                      {grant.fs.read.length ? <span className="font-mono text-xs break-all">{grant.fs.read.join(', ')}</span> : <span className="text-gray-700 dark:text-gray-300">its project only</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {grant.fs.write.length ? <span className="font-mono text-xs break-all">{grant.fs.write.join(', ')}</span> : <span className="text-gray-700 dark:text-gray-300">its project only</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <RepoGrants grant={grant} onChanged={() => client.invalidateQueries({ queryKey: ['tools'] })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mt-8 text-lg font-medium">What each tool does</h2>
          <ul className="mt-2 space-y-2">
            {q.data.tools.map((tool) => (
              <li key={tool.id}>
                <Card>
                  <p className="text-sm"><span className="font-mono text-xs">{tool.id}</span> <span className="text-gray-600 dark:text-gray-400">v{tool.version}</span></p>
                  <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{tool.description}</p>
                </Card>
              </li>
            ))}
          </ul>

          {q.data.remembered.length ? (
            <>
              <h2 className="mt-8 text-lg font-medium">Approvals you agreed to remember</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {q.data.remembered.map((rule) => (
                  <li key={JSON.stringify(rule)} className="font-mono text-xs">{JSON.stringify(rule)}</li>
                ))}
              </ul>
            </>
          ) : null}

          <h2 className="mt-8 text-lg font-medium">Refused</h2>
          {q.data.denials.length === 0 ? (
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">Nothing has been refused. This fills in as agents ask for things they do not have.</p>
          ) : (
            <table className="mt-2 w-full text-left text-sm">
              <caption className="sr-only">Tool calls that were refused, newest first</caption>
              <thead>
                <tr className="border-b border-gray-200 text-gray-700 dark:border-gray-800 dark:text-gray-300">
                  <th scope="col" className="py-2 pr-3 font-medium">When</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Agent</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Tool</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {q.data.denials.map((d) => (
                  <tr key={d.id} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 pr-3"><time dateTime={d.ts}>{new Date(d.ts).toLocaleString()}</time></td>
                    <td className="py-2 pr-3">{d.agentId ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{d.tool}</td>
                    <td className="py-2 pr-3">
                      {d.reason ?? d.errorCode ?? 'refused'}
                      {' '}<Link to={`/runs/${d.runId}`} className="text-blue-700 underline underline-offset-4 dark:text-sky-300">trace</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}

/**
 * One agent's repository grants, with the form that writes one (D-66). A person is still the one granting;
 * the form only spares them the text editor. The whole list is sent back each time, so the screen is the truth.
 */
function RepoGrants({ grant, onChanged }: { grant: AgentGrantSummary; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [repoPath, setRepoPath] = useState('');
  const [branches, setBranches] = useState('run/*');
  const save = useMutation({
    mutationFn: (repos: { path: string; branches: string; deny?: string[] }[]) => api.setRepos(grant.agentId, repos),
    onSuccess: () => { setOpen(false); setRepoPath(''); setBranches('run/*'); onChanged(); },
  });
  const current = grant.repos.map((r) => ({ path: r.path, branches: r.branches, deny: r.deny }));

  return (
    <div>
      {grant.repos.length ? (
        <ul className="space-y-1">
          {grant.repos.map((repo) => (
            <li key={`${repo.path}:${repo.branches}`} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs break-all">{repo.path}</span>
              <span className="text-xs text-gray-700 dark:text-gray-300">may push to <span className="font-mono">{repo.branches}</span></span>
              {repo.deny.length ? <span className="text-xs text-gray-700 dark:text-gray-300">may not write <span className="font-mono">{repo.deny.join(', ')}</span></span> : null}
              <Button size="sm" variant="ghost" onClick={() => save.mutate(current.filter((r) => r.path !== repo.path || r.branches !== repo.branches))} disabled={save.isPending} aria-label={`Remove repository ${repo.path} from ${grant.agentId}`}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : <span className="text-gray-700 dark:text-gray-300">none</span>}
      {open ? (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          aria-label={`Grant a repository to ${grant.agentId}`}
          onSubmit={(e) => { e.preventDefault(); if (repoPath.trim()) save.mutate([...current, { path: repoPath.trim(), branches: branches.trim() || 'run/*' }]); }}
        >
          <label className="block grow">
            <span className="block text-xs font-medium">Checkout path</span>
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="C:/Users/you/project" required className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-950" />
          </label>
          <label className="block">
            <span className="block text-xs font-medium">Branches it may push to</span>
            <input value={branches} onChange={(e) => setBranches(e.target.value)} className="mt-1 w-28 rounded border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-950" />
          </label>
          <Button type="submit" size="sm" disabled={save.isPending}>Grant</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        </form>
      ) : (
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => setOpen(true)} aria-label={`Grant a repository: ${grant.agentId}`}>Grant a repository…</Button>
      )}
      {save.isError ? <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">{save.error.message}</p> : null}
    </div>
  );
}

