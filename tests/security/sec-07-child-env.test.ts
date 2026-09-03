// SEC-07: childEnv() returns only the allowlist and no credential; process.env outside bootstrap/credentials fails lint.
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { childEnv } from '../../src/runtime/security/childEnv.js';
import { REPO } from '../helpers/workspace.js';

describe('SEC-07 child environment', () => {
  it('returns only PATH HOME TMPDIR LANG LC_* TZ', () => {
    const env = childEnv({ PATH: '/bin', HOME: '/h', TMPDIR: '/t', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', SECRET: 'x', WORKBENCH_CRED_GOOGLE: 'k', NODE_OPTIONS: '--inspect' });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ']);
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
});
