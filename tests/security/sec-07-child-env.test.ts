// SEC-07: childEnv() returns only the allowlist and no credential; process.env outside bootstrap/credentials fails lint.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { childEnv } from '../../src/runtime/security/childEnv.js';
import { REPO } from '../helpers/workspace.js';

describe('SEC-07 child environment', () => {
  it('returns only the allowlist for this platform, and nothing else', () => {
    const env = childEnv({
      PATH: '/bin', HOME: '/h', TMPDIR: '/t', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
      SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE', COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
      SECRET: 'x', WORKBENCH_CRED_GOOGLE: 'k', NODE_OPTIONS: '--inspect',
    });
    // The list is per-platform because the variables are: HOME and TMPDIR do not exist on Windows, and a child
    // there cannot start without SystemRoot. The refusals are not per-platform, and they are the point.
    const expected = process.platform === 'win32'
      ? ['COMSPEC', 'LC_ALL', 'PATH', 'PATHEXT', 'SystemRoot']
      : ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'];
    expect(Object.keys(env).sort()).toEqual(expected.sort());
    expect(Object.keys(env), 'a credential never rides along').not.toContain('WORKBENCH_CRED_GOOGLE');
    expect(Object.keys(env), 'nor an arbitrary secret').not.toContain('SECRET');
    // NODE_OPTIONS would let a child be handed --require or --inspect, which is a way into the process.
    expect(Object.keys(env), 'nor NODE_OPTIONS, which is executable by another name').not.toContain('NODE_OPTIONS');
  });
  it('refuses to pass a credential variable through extras', () => {
    expect(() => childEnv({ PATH: '/bin' }, { WORKBENCH_CRED_X: 'v' })).toThrow(/refusing/);
    expect(childEnv({ PATH: '/bin' }, { FOO: 'bar' })).toEqual({ PATH: '/bin', FOO: 'bar' });
  });
  it('lint: process.env is an error outside bootstrap.ts and credentials.ts', async () => {
    const eslint = new ESLint({ cwd: REPO });
    const code = 'export const probe = process.env.HOME;\n';
    const [engine] = await eslint.lintText(code, { filePath: path.join(REPO, 'src', 'runtime', 'engine', 'probe.ts') });
    expect(engine?.messages.some((m) => m.ruleId === 'no-restricted-properties')).toBe(true);
    const [tool] = await eslint.lintText(code, { filePath: path.join(REPO, 'src', 'runtime', 'tools', 'probe.ts') });
    expect(tool?.messages.some((m) => m.ruleId === 'no-restricted-properties')).toBe(true);
    const [bootstrap] = await eslint.lintText(code, { filePath: path.join(REPO, 'src', 'runtime', 'bootstrap.ts') });
    expect(bootstrap?.messages.some((m) => m.ruleId === 'no-restricted-properties')).toBe(false);
    const [creds] = await eslint.lintText(code, { filePath: path.join(REPO, 'src', 'runtime', 'security', 'credentials.ts') });
    expect(creds?.messages.some((m) => m.ruleId === 'no-restricted-properties')).toBe(false);
  }, 30_000);

  // RUN-01: an adapter gets its key and its fetch by injection, so neither escape hatch may appear in the folder.
  it('lint: an adapter may not read process.env or call global fetch', async () => {
    const eslint = new ESLint({ cwd: REPO });
    const adapterPath = path.join(REPO, 'src', 'runtime', 'models', 'adapters', 'probe', 'index.ts');
    const [env] = await eslint.lintText('export const k = process.env.GOOGLE_GENERATIVE_AI_API_KEY;\n', { filePath: adapterPath });
    expect(env?.messages.some((m) => m.ruleId === 'no-restricted-properties')).toBe(true);
    const [globalFetch] = await eslint.lintText('export const go = () => fetch("https://example.com");\n', { filePath: adapterPath });
    expect(globalFetch?.messages.some((m) => m.ruleId === 'no-restricted-globals')).toBe(true);
  }, 30_000);

  it('no adapter source names an environment variable or calls global fetch', () => {
    const dir = path.join(REPO, 'src', 'runtime', 'models', 'adapters');
    const files = listTs(dir);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${path.relative(REPO, file)} reads process.env`).not.toMatch(/process\.env/);
      // `ctx.fetch` and the FetchLike type are fine; a bare `fetch(` call is not.
      expect(source.replace(/\w\.fetch\b/g, ''), `${path.relative(REPO, file)} calls global fetch`).not.toMatch(/(?<![.\w])fetch\s*\(/);
    }
  });
});

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listTs(full) : full.endsWith('.ts') ? [full] : [];
  });
}
