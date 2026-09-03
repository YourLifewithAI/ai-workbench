// SEC-09 … SEC-13. This is the file that says the permission layer stays authoritative when the model is
// manipulated: every case below is one where the model asked nicely and the answer is still no.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { checkPath, Broker, HARD_DENY } from '../../src/runtime/security/broker.js';
import { effectivePermissions, intersect, intersectAll, narrowestMode, EMPTY_PERMISSIONS } from '../../src/runtime/security/permissions.js';
import { Permissions } from '../../src/shared/permissions.js';
import { tempWorkspace } from '../helpers/workspace.js';

const permissionsOf = (input: unknown): Permissions => Permissions.parse(input);
const policyFor = (ws: string, permissions: unknown) => ({
  workspaceDir: ws,
  permissions: permissionsOf(permissions),
  scratchDir: path.join(ws, 'runs', 'test-run'),
});

describe('SEC-09 tools default to deny', () => {
  const agent = { definition: { id: 'a', permissions: permissionsOf({ tools: { calc: 'allow' } }) } };
  const toolMax = permissionsOf({});

  it('a tool nobody granted is denied, however harmless it looks', () => {
    const decision = effectivePermissions({ requested: agent.definition.permissions, granted: undefined, toolMax }).decide('calc', false);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.hint).toContain('Grant it in the Tools screen');
  });

  it('the agent asking for it in its own file is not a grant', () => {
    const decision = effectivePermissions({
      requested: permissionsOf({ tools: { 'artifact.write': 'allow' } }),
      granted: permissionsOf({ tools: {} }),
      toolMax,
    }).decide('artifact.write', false);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.hint).toContain('asks for it in its own file');
  });

  it('a human granting it is', () => {
    const decision = effectivePermissions({
      requested: EMPTY_PERMISSIONS,
      granted: permissionsOf({ tools: { calc: 'allow' } }),
      toolMax,
    }).decide('calc', false);
    expect(decision.allowed).toBe(true);
  });

  it('an explicit deny beats a grant in any other layer', () => {
    const decision = effectivePermissions({
      requested: EMPTY_PERMISSIONS,
      granted: permissionsOf({ tools: { shell: 'deny' } }),
      toolMax: permissionsOf({ tools: { shell: 'allow' } }),
      workflowCeiling: permissionsOf({ tools: { shell: 'allow' } }),
    }).decide('shell', false);
    expect(decision.allowed).toBe(false);
  });
});

describe('SEC-10 the effective permission is an intersection; nothing widens', () => {
  it('a path survives only if both layers cover it', () => {
    const a = permissionsOf({ fs: { read: ['projects/anthology/'] } });
    const b = permissionsOf({ fs: { read: ['projects/'] } });
    expect(intersect(a, b).fs.read).toEqual(['projects/anthology/']);
    // The other direction gives the same answer: the narrower root is what survives, whichever side it is on.
    expect(intersect(b, a).fs.read).toEqual(['projects/anthology/']);
  });

  it('two disjoint roots intersect to nothing, not to both', () => {
    const a = permissionsOf({ fs: { write: ['projects/one/'] } });
    const b = permissionsOf({ fs: { write: ['projects/two/'] } });
    expect(intersect(a, b).fs.write).toEqual([]);
  });

  it('a sibling directory whose name is a prefix is not covered', () => {
    const a = permissionsOf({ fs: { read: ['projects/anthology-private/'] } });
    const b = permissionsOf({ fs: { read: ['projects/anthology/'] } });
    expect(intersect(a, b).fs.read).toEqual([]);
  });

  it('the network mode is the minimum over every layer', () => {
    expect(narrowestMode('unrestricted', 'allowlist', 'offline')).toBe('offline');
    expect(narrowestMode('unrestricted', 'allowlist')).toBe('allowlist');
    expect(narrowestMode(undefined, undefined)).toBe('offline');
  });

  it('an allowlist entry has to be in every layer', () => {
    const a = permissionsOf({ net: { mode: 'allowlist', allow: ['reuters.com', 'example.gov'] } });
    const b = permissionsOf({ net: { mode: 'allowlist', allow: ['reuters.com'] } });
    expect(intersect(a, b).net.allow).toEqual(['reuters.com']);
  });

  it('either layer may demand an approval and neither can waive the other\'s', () => {
    const a = permissionsOf({ approvalRequired: ['http.request'] });
    const b = permissionsOf({ approvalRequired: ['fs.write'] });
    expect(intersect(a, b).approvalRequired.sort()).toEqual(['fs.write', 'http.request']);
  });

  it('a run override cannot widen what the layers above it allow', () => {
    const wide = permissionsOf({ fs: { read: ['/'], write: ['/'] }, net: { mode: 'unrestricted', allow: ['*'] }, tools: { shell: 'allow' } });
    const composed = intersectAll(permissionsOf({ fs: { read: ['projects/'] } }), permissionsOf({ fs: { read: ['projects/'] } }), wide);
    expect(composed.fs.read).toEqual(['projects/']);
    expect(composed.fs.write).toEqual([]);
  });
});

describe('SEC-11 an agent cannot reach its own definition, config, credentials, or data/', () => {
  const ws = tempWorkspace('sec11');

  it.each(HARD_DENY)('denies %s even under a grant that covers the whole workspace', (denied) => {
    const decision = checkPath(path.join(ws, denied, 'anything.json'), ['.'], policyFor(ws, { fs: { read: ['.'], write: ['.'] } }), 'read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain(denied);
  });

  it('denies an agent its own agent.json through a grant whose root lexically contains "agents/"', () => {
    // The classic mistake: a root like `projects/my-agents/` shares a substring with `agents/`, and a lexical
    // check would let `../../agents/architect/agent.json` through it.
    const grant = ['projects/my-agents/'];
    const decision = checkPath(path.join(ws, 'projects', 'my-agents', '..', '..', 'agents', 'architect', 'agent.json'), grant, policyFor(ws, { fs: { read: grant } }), 'read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('agents/');
  });

  it('denies the runtime token and the credentials file by name', () => {
    for (const file of ['data/runtime.token', 'config/credentials.json']) {
      const decision = checkPath(path.join(ws, file), ['.'], policyFor(ws, { fs: { read: ['.'] } }), 'read');
      expect(decision.allowed, file).toBe(false);
    }
  });

  it('denies a symlink that points out of a granted root, though its lexical path is inside', async () => {
    const inside = path.join(ws, 'projects', 'anthology');
    fs.mkdirSync(inside, { recursive: true });
    const link = path.join(inside, 'escape.json');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(ws, 'agents', 'architect', 'agent.json'), link);

    const grant = ['projects/anthology/'];
    const decision = checkPath(link, grant, policyFor(ws, { fs: { read: grant } }), 'read');
    expect(decision.allowed, 'the real path is in agents/, whatever the lexical path says').toBe(false);

    const broker = new Broker(policyFor(ws, { fs: { read: grant } }));
    await expect(broker.read(link)).rejects.toThrow(/never readable/);
  });

  it('refuses to write through a symlink at the destination', async () => {
    const inside = path.join(ws, 'projects', 'anthology');
    fs.mkdirSync(inside, { recursive: true });
    const target = path.join(inside, 'real.md');
    fs.writeFileSync(target, 'original');
    const link = path.join(inside, 'link.md');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);

    const grant = ['projects/anthology/'];
    const broker = new Broker(policyFor(ws, { fs: { read: grant, write: grant } }));
    await expect(broker.write(link, 'overwritten')).rejects.toThrow(/symbolic link/);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
  });

  it('denies anything outside the workspace, including an absolute path to /etc', () => {
    const decision = checkPath('/etc/passwd', ['/'], policyFor(ws, { fs: { read: ['/'] } }), 'read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('outside this workspace');
  });

  it('allows the run\'s own scratch directory without any grant, so a masked result is recoverable', () => {
    const decision = checkPath(path.join(ws, 'runs', 'test-run', 'call_1.json'), [], policyFor(ws, {}), 'read');
    expect(decision.allowed).toBe(true);
  });
});
