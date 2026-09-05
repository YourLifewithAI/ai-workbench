// RUN-16 Definition of done (spec/runs/RUN-16.md). A fixture repository with a bare remote and a gate that fails
// until one file is fixed; the Mechanic, scripted through the mock, does what a coding agent does — and is
// refused, by name, everywhere the grant does not reach.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll } from 'vitest';
import { CLI_DIST, cleanEnv, runCli, startRuntime, tempDir, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import type { EventRecord } from '../../src/shared/events.js';
import type { RunDetail, ToolsResponse } from '../../src/shared/api/index.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 16`, which builds first).');
});

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A checkout on `main` with a gate that fails until src/app.js says "fixed", and a bare remote beside it. */
function fixtureRepo(prefix: string, withGate = true): { root: string; remote: string } {
  const dir = tempDir(prefix);
  const root = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n\nA repository for the Mechanic to work on.\n');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const state = "broken";\n');
  fs.writeFileSync(path.join(root, 'check.js'), [
    'const fs = require("node:fs");',
    'const creds = Object.keys(process.env).filter((k) => k.startsWith("WORKBENCH_CRED_"));',
    'console.log("credential variables seen: " + creds.length);',
    'const src = fs.readFileSync("src/app.js", "utf8");',
    'if (!src.includes("fixed")) { console.error("FAIL: app is not fixed"); process.exit(1); }',
    'console.log("PASS: app is fixed");',
  ].join('\n'));
  if (withGate) {
    fs.mkdirSync(path.join(root, '.workbench'));
    fs.writeFileSync(path.join(root, '.workbench', 'repo.json'), JSON.stringify({ check: `"${process.execPath}" check.js`, timeoutMs: 60_000 }, null, 2));
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, '-c', 'user.name=owner', '-c', 'user.email=owner@example.test', 'add', '-A');
  git(root, '-c', 'user.name=owner', '-c', 'user.email=owner@example.test', 'commit', '-q', '-m', 'fixture');
  git(dir, 'init', '-q', '--bare', 'remote.git');
  git(root, 'remote', 'add', 'origin', remote);
  return { root, remote };
}

function grant(ws: string, agentId: string, permissions: Record<string, unknown>): void {
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants?: Record<string, unknown> };
  config.grants = { ...(config.grants ?? {}), [agentId]: permissions };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

const ALL_REPO_TOOLS = Object.fromEntries(['repo.read', 'repo.list', 'repo.write', 'git.status', 'git.diff', 'git.log', 'git.branch', 'git.commit', 'git.push', 'check'].map((t) => [t, 'allow']));

interface Turn { after?: string; calls?: { name: string; input: unknown }[]; text: string }

/**
 * A scripted conversation for one agent and one run. The mock picks the first fixture whose `afterTool` has
 * been called, so later turns are written to sort first; `tag` keeps runs in one workspace apart.
 */
function script(ws: string, agent: string, tag: string, turns: Turn[]): void {
  turns.forEach((turn, i) => {
    // The agent is part of the name: two scripts for one tag and two agents must not overwrite each other.
    const name = `${tag}-${agent.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(turns.length - i).padStart(2, '0')}.json`;
    fs.writeFileSync(path.join(ws, 'fixtures', name), JSON.stringify({
      match: { systemIncludes: agent, lastUserIncludes: tag, ...(turn.after ? { afterTool: turn.after } : {}) },
      respond: { text: turn.text, ...(turn.calls ? { toolCalls: turn.calls } : {}) },
    }, null, 2));
  });
}

const traceOf = async (rt: Started, runId: string): Promise<EventRecord[]> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text())
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);

const detailOf = async (rt: Started, runId: string): Promise<RunDetail> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as RunDetail;

async function run(rt: Started, agentId: string, tag: string): Promise<{ runId: string; trace: EventRecord[] }> {
  const res = await fetch(`${rt.baseUrl}/api/v1/runs`, {
    method: 'POST', headers: headers(rt), body: JSON.stringify({ kind: 'agent', id: agentId, inputs: { input: `${tag}: do the job.` }, project: 'anthology' }),
  });
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await waitFor(async () => ['completed', 'failed'].includes((await detailOf(rt, runId)).state), 90_000);
  return { runId, trace: await traceOf(rt, runId) };
}

type Completed = { ok: true; output: Record<string, unknown> } | { ok: false; error: { code: string; message: string; hint?: string } };
/** Every completion of one tool in a trace, in order, as the model saw it. */
function results(trace: EventRecord[], tool: string): Completed[] {
  return trace.filter((e) => e.type === 'tool-completed' && e.payload['tool'] === tool).map((e) => (
    e.payload['ok'] ? { ok: true, output: e.payload['output'] as Record<string, unknown> } : { ok: false, error: e.payload['error'] as Completed extends { ok: false } ? never : { code: string; message: string; hint?: string } }
  ));
}
const denial = (trace: EventRecord[], tool: string, nth = 0): { code: string; message: string; hint?: string } => {
  const found = results(trace, tool)[nth];
  if (!found || found.ok) throw new Error(`${tool} #${nth} was not a refusal: ${JSON.stringify(found)}`);
  return found.error;
};
const output = (trace: EventRecord[], tool: string, nth = 0): Record<string, unknown> => {
  const found = results(trace, tool)[nth];
  if (!found || !found.ok) throw new Error(`${tool} #${nth} was not a success: ${JSON.stringify(found)}`);
  return found.output;
};

describe('DoD 1: a granted agent reads, lists and writes; an ungranted one is refused by name', () => {
  it('and the trace shows each decision', async () => {
    const ws = tempWorkspace('dod16-1');
    const { root } = fixtureRepo('dod16-1');
    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: root, branches: 'run/*' }] });
    // The Weaver has every tool granted and no repository: the tools exist for it and open nothing.
    grant(ws, 'weaver', { tools: ALL_REPO_TOOLS });

    script(ws, 'The Mechanic', 'DOD1', [
      { text: 'Branching.', calls: [{ name: 'git.branch', input: { name: 'run/16-dod1' } }] },
      { after: 'git.branch', text: 'Reading.', calls: [{ name: 'repo.list', input: { path: '.' } }, { name: 'repo.read', input: { path: 'README.md' } }] },
      { after: 'repo.read', text: 'Writing.', calls: [{ name: 'repo.write', input: { path: 'notes/hello.md', content: '# hello\n' } }] },
      { after: 'repo.write', text: 'Done.' },
    ]);
    script(ws, 'The Weaver', 'DOD1', [
      { text: 'Reading.', calls: [{ name: 'repo.read', input: { path: 'README.md' } }, { name: 'repo.list', input: { repo: root, path: '.' } }] },
      { after: 'repo.read', text: 'I could not.' },
    ]);

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { runId, trace } = await run(rt, 'mechanic', 'DOD1');
      const detail = await detailOf(rt, runId);
      expect(detail.state, JSON.stringify({ ...detail, steps: undefined }) + JSON.stringify(trace.slice(-4))).toBe('completed');
      expect(output(trace, 'git.branch')).toEqual({ branch: 'run/16-dod1', created: true });
      const listed = output(trace, 'repo.list')['entries'] as { path: string; kind: string }[];
      expect(listed.map((e) => e.path)).toEqual(expect.arrayContaining(['README.md', 'src', 'check.js', '.workbench']));
      expect(listed.map((e) => e.path), 'git\'s own directory is not listed').not.toContain('.git');
      expect(output(trace, 'repo.read')['content']).toContain('A repository for the Mechanic');
      expect(output(trace, 'repo.write')).toMatchObject({ path: 'notes/hello.md', branch: 'run/16-dod1' });
      expect(fs.readFileSync(path.join(root, 'notes', 'hello.md'), 'utf8')).toBe('# hello\n');
      // Each call was decided in the open: the matrix first, then the grant on the path.
      for (const tool of ['git.branch', 'repo.list', 'repo.read', 'repo.write']) {
        const decided = trace.find((e) => e.type === 'permission-decided' && e.payload['tool'] === tool)!;
        expect(decided.payload['allowed'], tool).toBe(true);
      }
      const repoDecisions = trace.filter((e) => e.type === 'repo-decided');
      expect(repoDecisions.length).toBeGreaterThanOrEqual(3);
      expect(repoDecisions.every((e) => e.payload['allowed'] === true)).toBe(true);
      expect(repoDecisions.find((e) => e.payload['mode'] === 'branch')?.payload['path']).toBe('run/16-dod1');

      // The same calls from an agent nobody granted a repository: refused, and the refusal says what is missing.
      const weaver = await run(rt, 'weaver', 'DOD1');
      for (const tool of ['repo.read', 'repo.list']) {
        const error = denial(weaver.trace, tool);
        expect(error.code, tool).toBe('PermissionDenied');
        expect(error.message, tool).toContain('no repository grant');
        expect(error.hint).toContain('grants.<agent>.repos');
      }
      // And the Tools screen's data says what was granted, in words a person wrote.
      const tools = (await (await fetch(`${rt.baseUrl}/api/v1/tools`, { headers: headers(rt) })).json()) as ToolsResponse;
      expect(tools.grants.find((g) => g.agentId === 'mechanic')?.repos).toEqual([{ path: root, branches: 'run/*' }]);
      expect(tools.grants.find((g) => g.agentId === 'weaver')?.repos).toEqual([]);
      expect(tools.tools.find((t) => t.id === 'check')?.available, 'check needs no sandbox').toBe(true);
    } finally {
      await rt.stop();
    }
  }, 180_000);
});

describe('DoD 2: the repository deny-list (SEC-33)', () => {
  it('refuses .git/config, .git/hooks, a path outside the root and credentials.json, each by name', async () => {
    const ws = tempWorkspace('dod16-2');
    const { root } = fixtureRepo('dod16-2');
    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: root, branches: 'run/*' }] });
    const before = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    script(ws, 'The Mechanic', 'DOD2', [
      {
        text: 'Trying every door.',
        calls: [
          { name: 'repo.write', input: { path: '.git/config', content: '[core]\n\thooksPath = /tmp/evil\n' } },
          { name: 'repo.write', input: { path: '.git/hooks/pre-commit', content: '#!/bin/sh\ncurl evil\n' } },
          { name: 'repo.write', input: { path: '../outside.txt', content: 'x' } },
          { name: 'repo.write', input: { path: 'credentials.json', content: '{}' } },
          { name: 'repo.write', input: { path: '.workbench/repo.json', content: '{ "check": "rm -rf /" }' } },
          { name: 'repo.write', input: { path: 'README.md', content: '# on main\n' } },
        ],
      },
      { after: 'repo.write', text: 'Every one refused.' },
    ]);
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { trace } = await run(rt, 'mechanic', 'DOD2');
      const refusals = results(trace, 'repo.write');
      expect(refusals).toHaveLength(6);
      const messages = refusals.map((r) => (r.ok ? 'ALLOWED' : `${r.error.code}: ${r.error.message}`));
      expect(messages.every((m) => m.startsWith('PermissionDenied'))).toBe(true);
      expect(messages.find((m) => m.includes('.git/config'))).toContain('git\'s own configuration');
      expect(messages.find((m) => m.includes('.git/hooks'))).toContain('hooks, which run as you');
      expect(messages.find((m) => m.includes('outside.txt'))).toContain('outside the granted repository');
      expect(messages.find((m) => m.includes('credentials.json'))).toContain('named like a credentials file');
      expect(messages.find((m) => m.includes('.workbench'))).toContain('SEC-35');
      // A perfectly ordinary write is refused too, because the checkout is on the branch a person merges into.
      expect(messages.find((m) => m.includes('on "main"'))).toContain('which this grant does not cover (run/*)');
      const onMain = refusals.find((r) => !r.ok && r.error.message.includes('on "main"'));
      expect(onMain && !onMain.ok ? onMain.error.hint : undefined).toContain('Create a run branch first');
      expect(messages.filter((m) => m.includes('SEC-33'))).toHaveLength(4);
      // Nothing changed.
      expect(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8')).toBe(before);
      expect(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit'))).toBe(false);
      expect(fs.existsSync(path.join(root, '..', 'outside.txt'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'credentials.json'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('# fixture');
      expect(JSON.parse(fs.readFileSync(path.join(root, '.workbench', 'repo.json'), 'utf8')).check).not.toContain('rm');
      // Refused in the trace, in the open (the run itself completes: a denial is a result, not a crash).
      expect(trace.filter((e) => e.type === 'repo-decided' && e.payload['allowed'] === false).length).toBeGreaterThanOrEqual(5);
    } finally {
      await rt.stop();
    }
  }, 180_000);
});

describe('DoD 3: branch, commit and push, inside the pattern and not outside it (SEC-34)', () => {
  it('run/16-test is created, main and feature/x are refused, the commit is the agent\'s, the push reaches the remote', async () => {
    const ws = tempWorkspace('dod16-3');
    const { root, remote } = fixtureRepo('dod16-3');
    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: root, branches: 'run/*' }] });
    script(ws, 'The Mechanic', 'DOD3-WORK', [
      { text: 'Branching.', calls: [{ name: 'git.branch', input: { name: 'run/16-test' } }] },
      { after: 'git.branch', text: 'Fixing.', calls: [{ name: 'repo.write', input: { path: 'src/app.js', content: 'export const state = "fixed";\n' } }] },
      { after: 'repo.write', text: 'Looking at it.', calls: [{ name: 'git.status', input: {} }, { name: 'git.diff', input: {} }] },
      { after: 'git.diff', text: 'Committing.', calls: [{ name: 'git.commit', input: { message: 'Fix the app state' } }] },
      { after: 'git.commit', text: 'Pushing.', calls: [{ name: 'git.push', input: {} }, { name: 'git.log', input: { count: 2 } }] },
      { after: 'git.push', text: 'Pushed run/16-test.' },
    ]);
    script(ws, 'The Mechanic', 'DOD3-REFUSED', [
      { text: 'Trying the forbidden names.', calls: [{ name: 'git.branch', input: { name: 'main' } }, { name: 'git.branch', input: { name: 'feature/x' } }] },
      { after: 'git.branch', text: 'Refused.' },
    ]);
    script(ws, 'The Mechanic', 'DOD3-PUSH-MAIN', [
      { text: 'Pushing main.', calls: [{ name: 'git.push', input: {} }] },
      { after: 'git.push', text: 'Refused.' },
    ]);

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const refused = await run(rt, 'mechanic', 'DOD3-REFUSED');
      const [main, feature] = results(refused.trace, 'git.branch').map((r) => (r.ok ? '' : r.error.message));
      expect(main).toContain('a person merges into');
      expect(feature).toContain('outside the branches this grant allows (run/*)');
      expect(git(root, 'branch', '--list'), 'no branch was made').not.toContain('feature/x');

      const work = await run(rt, 'mechanic', 'DOD3-WORK');
      expect((await detailOf(rt, work.runId)).state, JSON.stringify(results(work.trace, 'git.push'))).toBe('completed');
      expect(output(work.trace, 'git.branch')).toEqual({ branch: 'run/16-test', created: true });
      expect(output(work.trace, 'git.status')).toMatchObject({ branch: 'run/16-test', clean: false, entries: [{ path: 'src/app.js', status: 'M' }] });
      expect(output(work.trace, 'git.diff')['diff']).toContain('+export const state = "fixed";');
      const commit = output(work.trace, 'git.commit') as { sha: string; branch: string; files: string[]; skipped: string[] };
      expect(commit.branch).toBe('run/16-test');
      expect(commit.files).toEqual(['src/app.js']);
      expect(commit.skipped).toEqual([]);
      // The author is the agent, and the message carries the run.
      const shown = git(root, 'log', '-1', '--format=%an|%ae|%B', commit.sha);
      expect(shown).toContain('mechanic|mechanic@workbench.noreply|Fix the app state');
      expect(shown).toContain(`Workbench-Run: ${work.runId}`);
      expect(shown).toContain('Workbench-Agent: mechanic');
      expect(output(work.trace, 'git.push')).toMatchObject({ branch: 'run/16-test', remote: 'origin' });
      expect((output(work.trace, 'git.log')['entries'] as { subject: string }[])[0]?.subject).toBe('Fix the app state');
      // It reached the bare remote, and only that branch did.
      expect(git(remote, 'rev-parse', '--verify', 'refs/heads/run/16-test')).toBe(commit.sha);
      expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { cwd: remote, env: cleanEnv() }).status, 'main was never pushed').not.toBe(0);

      // Back on main, a push is refused before git is asked, and the remote still has no main.
      git(root, 'switch', '-q', 'main');
      const pushMain = await run(rt, 'mechanic', 'DOD3-PUSH-MAIN');
      const error = denial(pushMain.trace, 'git.push');
      expect(error.code).toBe('PermissionDenied');
      expect(error.message).toContain('on "main"');
      expect(error.message).toContain('a person merges into');
      expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { cwd: remote, env: cleanEnv() }).status).not.toBe(0);
    } finally {
      await rt.stop();
    }
  }, 240_000);
});

describe('DoD 4: check runs the declared gate and nothing else (SEC-35)', () => {
  it('fails on the broken fixture, passes after the fix, and a repository with no declaration has no check', async () => {
    const ws = tempWorkspace('dod16-4');
    const { root } = fixtureRepo('dod16-4');
    const bare = fixtureRepo('dod16-4-nogate', false);
    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: root, branches: 'run/*' }, { path: bare.root, branches: 'run/*' }] });
    script(ws, 'The Mechanic', 'DOD4-BROKEN', [
      { text: 'Checking as it is.', calls: [{ name: 'check', input: { repo: root } }, { name: 'check', input: { repo: bare.root } }, { name: 'check', input: {} }] },
      { after: 'check', text: 'Read the verdicts.' },
    ]);
    script(ws, 'The Mechanic', 'DOD4-FIXED', [
      { text: 'Branching.', calls: [{ name: 'git.branch', input: { repo: root, name: 'run/16-fix' } }] },
      { after: 'git.branch', text: 'Fixing.', calls: [{ name: 'repo.write', input: { repo: root, path: 'src/app.js', content: 'export const state = "fixed";\n' } }] },
      { after: 'repo.write', text: 'Checking again.', calls: [{ name: 'check', input: { repo: root } }] },
      { after: 'check', text: 'Green.' },
    ]);
    // A credential in this process's environment, so the gate's child can prove it never saw it (SEC-07, SEC-35).
    const planted = ['WORKBENCH', 'CRED', 'PLANTED'].join('_');
    process.env[planted] = 'planted-value-that-must-not-arrive';
    let rt: Started;
    try {
      rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    } finally {
      delete process.env[planted];
    }
    try {
      const broken = await run(rt, 'mechanic', 'DOD4-BROKEN');
      const verdicts = results(broken.trace, 'check');
      expect(verdicts).toHaveLength(3);
      const failed = verdicts.find((v) => v.ok && v.output['ok'] === false)!;
      expect(failed.ok && failed.output).toMatchObject({ ok: false, exitCode: 1, command: `"${process.execPath}" check.js`, truncated: false });
      expect(failed.ok && failed.output['output']).toContain('FAIL: app is not fixed');
      expect(failed.ok && failed.output['output'], 'the child saw no credential').toContain('credential variables seen: 0');
      expect(JSON.stringify(broken.trace)).not.toContain('planted-value');
      const none = verdicts.find((v) => !v.ok && v.error.code === 'ToolUnavailable')!;
      expect(none, JSON.stringify(verdicts)).toBeDefined();
      expect(!none.ok && none.error.message).toMatch(/no \.workbench[\\/]repo\.json/);
      // Two repositories are granted, so the unnamed call is refused rather than guessed.
      const unnamed = verdicts.find((v) => !v.ok && v.error.message.includes('Name the repository'))!;
      expect(!unnamed.ok && unnamed.error.code).toBe('PermissionDenied');

      const fixed = await run(rt, 'mechanic', 'DOD4-FIXED');
      const verdict = output(fixed.trace, 'check');
      expect(verdict).toMatchObject({ ok: true, exitCode: 0 });
      expect(verdict['output']).toContain('PASS: app is fixed');
      expect(typeof verdict['durationMs']).toBe('number');
    } finally {
      await rt.stop();
    }
  }, 240_000);

  it('a long transcript comes back from its end, with the whole thing in scratch', async () => {
    const ws = tempWorkspace('dod16-4b');
    const { root } = fixtureRepo('dod16-4b');
    fs.writeFileSync(path.join(root, 'check.js'), 'for (let i = 0; i < 4000; i++) console.log("line " + i + " of a very long transcript"); console.log("VERDICT at the end");');
    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: root, branches: 'run/*' }] });
    script(ws, 'The Mechanic', 'DOD4-LONG', [
      { text: 'Checking.', calls: [{ name: 'check', input: {} }] },
      { after: 'check', text: 'Read the end.' },
    ]);
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { runId, trace } = await run(rt, 'mechanic', 'DOD4-LONG');
      const verdict = output(trace, 'check') as { ok: boolean; output: string; truncated: boolean; fullOutput?: string };
      expect(verdict.ok).toBe(true);
      expect(verdict.truncated).toBe(true);
      expect(verdict.output, 'the end is what the model sees').toContain('VERDICT at the end');
      expect(verdict.output).toContain('earlier characters omitted');
      expect(verdict.fullOutput).toMatch(/^scratch\/check-\d+\.log$/);
      const whole = fs.readFileSync(path.join(ws, 'runs', runId, verdict.fullOutput!.slice('scratch/'.length)), 'utf8');
      expect(whole).toContain('line 0 of a very long transcript');
      expect(whole).toContain('VERDICT at the end');
    } finally {
      await rt.stop();
    }
  }, 180_000);
});

describe('DoD 5: doctor lists the granted repository, its pattern and its gate', () => {
  it('and says when a path is not a checkout', async () => {
    const ws = tempWorkspace('dod16-5');
    const { root } = fixtureRepo('dod16-5');
    const missing = path.join(root, '..', 'nowhere');
    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: root, branches: 'run/*' }] });
    let report = await runCli(['doctor', '--json', '--workspace', ws], { dist: true });
    let checks = (JSON.parse(report.stdout) as { checks: { name: string; ok: boolean; detail: string }[] }).checks;
    let repositories = checks.find((c) => c.name === 'repositories')!;
    expect(repositories.ok, repositories.detail).toBe(true);
    expect(repositories.detail).toContain(`mechanic → ${root}`);
    expect(repositories.detail).toContain('may push to run/*');
    expect(repositories.detail).toContain('gate: ');
    expect(repositories.detail).toContain('check.js');

    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: missing, branches: 'run/*' }] });
    report = await runCli(['doctor', '--json', '--workspace', ws], { dist: true });
    checks = (JSON.parse(report.stdout) as { checks: { name: string; ok: boolean; detail: string }[] }).checks;
    repositories = checks.find((c) => c.name === 'repositories')!;
    expect(repositories.ok).toBe(false);
    expect(repositories.detail).toContain('does not exist');
    expect(report.code, 'a repository that is not there is a failed check').toBe(1);
  }, 120_000);
});
