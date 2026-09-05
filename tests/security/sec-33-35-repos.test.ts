// SEC-33, SEC-34, SEC-35: a repository grant is a door to one checkout and its run branches, and nothing else.
// Every case here is the model asking for something a person did not give it, and the answer staying no.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { checkRepoPath } from '../../src/runtime/security/repoPolicy.js';
import { credentialShaped } from '../../src/runtime/security/secretScan.js';
import { childEnv } from '../../src/runtime/security/childEnv.js';
import { intersect } from '../../src/runtime/security/permissions.js';
import { Permissions } from '../../src/shared/permissions.js';
import { branchAllowed, branchMatches, narrowerBranches, validBranchName } from '../../src/shared/repo.js';
import { repoHandle } from '../../src/runtime/repos/access.js';
import { readGate, runGate } from '../../src/runtime/repos/gate.js';
import { repoTools } from '../../src/runtime/tools/builtin/repo.js';
import { toolSpec } from '../../src/shared/tool.js';
import type { GitExec } from '../../src/runtime/repos/git.js';
import { tempDir, tempWorkspace } from '../helpers/workspace.js';

function repoDir(): string {
  const root = path.join(tempDir('sec33'), 'repo');
  for (const dir of ['.git/hooks', '.git/objects', '.git/refs', 'src', '.workbench']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const ok = 1;\n');
  fs.writeFileSync(path.join(root, 'credentials.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.env'), 'X=1\n');
  fs.writeFileSync(path.join(root, '.env.example'), 'X=\n');
  fs.writeFileSync(path.join(root, 'id_rsa'), '-----BEGIN\n');
  fs.writeFileSync(path.join(root, '.workbench', 'repo.json'), '{ "check": "true" }\n');
  fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'not yours\n');
  return root;
}

describe('SEC-33 a repository grant never opens git\'s internals, a credentials-shaped file, or anything outside the root', () => {
  const root = repoDir();
  const ws = tempWorkspace('sec33-ws');
  const policy = { root, workspaceDir: ws };

  it('an ordinary file inside the root is allowed, for reading and writing', () => {
    expect(checkRepoPath('src/app.js', policy, 'read').allowed).toBe(true);
    expect(checkRepoPath('src/app.js', policy, 'write').allowed).toBe(true);
    expect(checkRepoPath('src/new-file.js', policy, 'write').allowed, 'a file that does not exist yet').toBe(true);
  });

  it('every git internal is refused by name, in both modes', () => {
    for (const [candidate, word] of [['.git/config', 'configuration'], ['.git/hooks/pre-commit', 'hooks'], ['.git/objects/ab', 'history'], ['.git/refs/heads/main', 'refs'], ['.git/HEAD', 'HEAD'], ['.git/packed-refs', 'git\'s own state']] as const) {
      for (const mode of ['read', 'write'] as const) {
        const decision = checkRepoPath(candidate, policy, mode);
        expect(decision.allowed, `${mode} ${candidate}`).toBe(false);
        expect(decision.reason, candidate).toContain(word);
        expect(decision.reason).toContain('SEC-33');
      }
    }
  });

  it('a path that resolves outside the granted root is refused, however it is spelled', () => {
    for (const candidate of ['../outside.txt', 'src/../../outside.txt', path.join(path.dirname(root), 'outside.txt')]) {
      const decision = checkRepoPath(candidate, policy, 'read');
      expect(decision.allowed, candidate).toBe(false);
      expect(decision.reason).toContain('outside the granted repository');
    }
  });

  it('a symlink inside the root that points outside is refused on where it really goes', () => {
    const link = path.join(root, 'src', 'escape.txt');
    try {
      fs.symlinkSync(path.join(path.dirname(root), 'outside.txt'), link);
    } catch {
      return; // no symlink privilege on this Windows account: the case is meaningless here, not failed
    }
    const decision = checkRepoPath('src/escape.txt', policy, 'read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('outside the granted repository');
  });

  it('a file named like a credential is refused whatever is in it; a template is not', () => {
    for (const name of ['credentials.json', '.env', 'id_rsa', 'src/../.env', 'deploy.pem', 'secrets.yaml', '.npmrc', '.git-credentials']) {
      const decision = checkRepoPath(name, policy, 'read');
      expect(decision.allowed, name).toBe(false);
      expect(decision.reason).toContain('credentials file');
    }
    expect(checkRepoPath('.env.example', policy, 'read').allowed).toBe(true);
    expect(credentialShaped('.env.sample')).toBeNull();
    expect(credentialShaped('service-account-prod.json')).toBe('service-account');
  });

  it('the gate declaration is readable and never writable: the agent does not get to name the command', () => {
    expect(checkRepoPath('.workbench/repo.json', policy, 'read').allowed).toBe(true);
    const decision = checkRepoPath('.workbench/repo.json', policy, 'write');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('SEC-35');
  });

  it('a grant that covers the workspace is still not a door to its config or credentials (SEC-11)', () => {
    const wide = { root: ws, workspaceDir: ws };
    expect(checkRepoPath('config/workbench.json', wide, 'write').allowed).toBe(false);
    expect(checkRepoPath('agents/echo/agent.json', wide, 'write').allowed).toBe(false);
    expect(checkRepoPath('data/workbench.sqlite', wide, 'read').allowed).toBe(false);
    expect(checkRepoPath('projects/README.md', wide, 'read').allowed).toBe(true);
  });

  it('the intersection keeps the narrower root and the narrower pattern, and nothing widens', () => {
    const tool = Permissions.parse({ repos: [{ path: '/', branches: '**' }] });
    const granted = Permissions.parse({ repos: [{ path: root, branches: 'run/*' }] });
    expect(intersect(tool, granted).repos).toEqual([{ path: root, branches: 'run/*', deny: [] }]);
    // A ceiling that names a narrower pattern narrows; one that names an unrelated one leaves nothing.
    const narrower = Permissions.parse({ repos: [{ path: root, branches: 'run/16-*' }] });
    expect(intersect(granted, narrower).repos).toEqual([{ path: root, branches: 'run/16-*', deny: [] }]);
    // Denies add up across layers: a directory either layer refuses stays refused (RUN-17).
    const briefs = Permissions.parse({ repos: [{ path: '/', branches: '**', deny: ['spec/runs'] }] });
    expect(intersect(granted, briefs).repos).toEqual([{ path: root, branches: 'run/*', deny: ['spec/runs'] }]);
    expect(checkRepoPath('spec/runs/RUN-99.md', { root, workspaceDir: ws, deny: ['spec/runs'] }, 'write').allowed).toBe(false);
    expect(checkRepoPath('spec/runs/RUN-99.md', { root, workspaceDir: ws, deny: ['spec/runs'] }, 'read').allowed).toBe(true);
    expect(checkRepoPath('spec/runs-notes.md', { root, workspaceDir: ws, deny: ['spec/runs'] }, 'write').allowed, 'a sibling whose name is a prefix is not under it').toBe(true);
    const unrelated = Permissions.parse({ repos: [{ path: root, branches: 'feature/*' }] });
    expect(intersect(granted, unrelated).repos).toEqual([]);
    // A different repository is not this one.
    const elsewhere = Permissions.parse({ repos: [{ path: path.join(root, '..', 'other'), branches: 'run/*' }] });
    expect(intersect(granted, elsewhere).repos).toEqual([]);
    // And an agent that asks in its own file gets nothing from asking: the request layer is not in the product.
    expect(Permissions.parse({}).repos).toEqual([]);
  });
});

describe('SEC-34 push is refused outside the pattern, main first; no merge tool exists', () => {
  it('the pattern, and the two names no pattern reaches', () => {
    expect(branchMatches('run/*', 'run/16-repository-tools')).toBe(true);
    expect(branchMatches('run/*', 'run/16/nested')).toBe(false);
    expect(branchMatches('run/**', 'run/16/nested')).toBe(true);
    expect(branchMatches('*', 'main')).toBe(true);
    for (const pattern of ['run/*', '*', '**']) {
      for (const protectedName of ['main', 'master']) {
        const verdict = branchAllowed(pattern, protectedName);
        expect(verdict.allowed, `${protectedName} under ${pattern}`).toBe(false);
        expect(verdict.reason).toContain('a person merges into');
      }
    }
    expect(branchAllowed('run/*', 'feature/x').allowed).toBe(false);
    expect(branchAllowed('run/*', 'feature/x').reason).toContain('outside the branches this grant allows');
    expect(branchAllowed('run/*', 'run/16-test').allowed).toBe(true);
  });

  it('a branch name cannot be an option, a traversal, or a lock', () => {
    for (const bad of ['--force', '-f', 'run/../main', 'run//x', 'run/x.lock', 'run/x/', 'run/x.', '']) {
      expect(validBranchName(bad), bad).toBe(false);
    }
    expect(narrowerBranches('run/*', 'run/16-*')).toBe('run/16-*');
    expect(narrowerBranches('run/*', 'feature/*')).toBeNull();
    expect(narrowerBranches('**', 'run/*')).toBe('run/*');
  });

  it('a push from main is refused before git is ever asked to push', async () => {
    const root = repoDir();
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push(args);
      if (args[0] === 'symbolic-ref') return { ok: true, code: 0, stdout: 'main\n', stderr: '' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };
    const handle = repoHandle({
      grants: [{ path: root, branches: 'run/*', deny: [] }], workspaceDir: tempWorkspace('sec34'), env: {}, git: exec,
      agentId: 'mechanic', runId: 'r1', signal: new AbortController().signal, maxOutputChars: () => 1000,
      writeScratch: async (name) => `scratch/${name}`,
    });
    const repo = await handle.open(undefined);
    await expect(repo.git.push()).rejects.toMatchObject({ code: 'PermissionDenied', message: expect.stringMatching(/"main"/) });
    expect(calls.map((c) => c[0]), 'git was asked where it was, and nothing else').toEqual(['symbolic-ref']);
    // The same rule in front of a write and a commit: main is not a place this agent works.
    await expect(repo.write('src/app.js', 'x')).rejects.toMatchObject({ code: 'PermissionDenied', message: expect.stringMatching(/on "main"/) });
    await expect(repo.git.commit('x')).rejects.toMatchObject({ code: 'PermissionDenied' });
    expect(calls.some((c) => c[0] === 'push' || c[0] === 'commit' || c[0] === 'add')).toBe(false);
    expect(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'and the file is untouched').toBe('export const ok = 1;\n');
    // A remote name is a name, not an option.
    await expect(repo.git.push('--mirror')).rejects.toMatchObject({ code: 'PermissionDenied' });
  });

  it('there is no tool that merges, rebases, resets or forces, and push takes no flag', () => {
    const ids = repoTools().map((t) => t.id).sort();
    expect(ids).toEqual(['check', 'git.branch', 'git.commit', 'git.diff', 'git.log', 'git.push', 'git.status', 'repo.list', 'repo.read', 'repo.write']);
    const push = repoTools().find((t) => t.id === 'git.push')!;
    const schema = toolSpec(push).inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(['remote', 'repo']);
    expect(JSON.stringify(schema)).not.toMatch(/force|mirror|delete/);
  });
});

describe('SEC-35 check runs only the declared command, with a scrubbed environment', () => {
  it('the tool\'s input has no command in it', () => {
    const check = repoTools().find((t) => t.id === 'check')!;
    const schema = toolSpec(check).inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['repo']);
    expect(check.tier).toBe('execute');
    expect(check.runsOnHost).toBe(true);
  });

  it('a repository with no declaration has no check, by name; a bad one is refused, not guessed', () => {
    const root = path.join(tempDir('sec35'), 'repo');
    fs.mkdirSync(root, { recursive: true });
    expect(() => readGate(root)).toThrow(/no .workbench[\\/]repo\.json/);
    fs.mkdirSync(path.join(root, '.workbench'));
    fs.writeFileSync(path.join(root, '.workbench', 'repo.json'), '{ "check": "npm test", "shell": "bash" }');
    expect(() => readGate(root), 'an unknown key is a mistake, not a feature').toThrow(/Unrecognized key|unrecognized/i);
    fs.writeFileSync(path.join(root, '.workbench', 'repo.json'), '{ "check": "npm test" }');
    expect(readGate(root)).toEqual({ check: 'npm test', timeoutMs: 900_000 });
  });

  it('the gate\'s child sees the allowlist and no credential', async () => {
    const root = path.join(tempDir('sec35-env'), 'repo');
    fs.mkdirSync(path.join(root, '.workbench'), { recursive: true });
    fs.writeFileSync(path.join(root, 'env.js'), 'console.log("VARS " + Object.keys(process.env).sort().join(","))');
    fs.writeFileSync(path.join(root, '.workbench', 'repo.json'), JSON.stringify({ check: `"${process.execPath}" env.js` }));
    // What bootstrap would hand over, plus a planted credential and an arbitrary secret. Neither may arrive.
    const planted = ['WORKBENCH', 'CRED', 'PLANTED'].join('_');
    const allowlist: Record<string, string> = { PATH: process.env['PATH'] ?? '', SECRET_THING: 'x', [planted]: 'never' };
    for (const key of ['HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'PATHEXT', 'COMSPEC', 'USERPROFILE']) if (process.env[key]) allowlist[key] = process.env[key]!;
    const result = await runGate({ root, gate: readGate(root), env: childEnv(allowlist), signal: new AbortController().signal });
    expect(result.ok, result.output).toBe(true);
    expect(result.output).toContain('VARS ');
    expect(result.output).not.toContain(planted);
    expect(result.output).not.toContain('SECRET_THING');
    expect(result.output).toContain('PATH');
    // And the scrubbed environment refuses a credential outright rather than filtering it quietly.
    expect(() => childEnv(allowlist, { [planted]: 'v' })).toThrow(/refusing/);
  });
});
