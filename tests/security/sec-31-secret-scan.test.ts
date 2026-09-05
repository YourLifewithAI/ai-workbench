// SEC-31: the check-gate secret scanner catches a key assembled at test time in a temp directory.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { scanDirectory, scanText } from '../../src/runtime/security/secretScan.js';
import { REPO, TSX, TSX_ENTRY, tempDir } from '../helpers/workspace.js';

const assembled = (): string => ['AI', 'za'].join('') + 'Sy' + 'Q'.repeat(33);

describe('SEC-31 secret scan', () => {
  it('finds a planted Google-style key, a WORKBENCH_CRED_ assignment, and nothing in clean text', () => {
    expect(scanText(`const k = "${assembled()}";`).map((f) => f.pattern)).toEqual(['google-api-key']);
    expect(scanText(['WORKBENCH', 'CRED', 'GOOGLE'].join('_') + '=' + 'abcdefghijklmnopqrstuvwxyz').map((f) => f.pattern)).toEqual(['workbench-cred-env']);
    expect(scanText('const url = "https://example.com"; const short = "sk-abc";')).toEqual([]);
  });

  it('the npm script exits 1 on a directory with a planted key and 0 on a clean one', () => {
    const dirty = tempDir('sec31-dirty');
    fs.mkdirSync(path.join(dirty, 'src'));
    fs.writeFileSync(path.join(dirty, 'src', 'oops.ts'), `export const key = '${assembled()}';\n`);
    expect(scanDirectory(dirty)).toHaveLength(1);
    const bad = spawnSync(TSX, [TSX_ENTRY, path.join(REPO, 'scripts', 'secret-scan.ts'), dirty], { cwd: REPO, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('oops.ts:1');
    const clean = tempDir('sec31-clean');
    fs.writeFileSync(path.join(clean, 'fine.ts'), 'export const nothing = 1;\n');
    const ok = spawnSync(TSX, [TSX_ENTRY, path.join(REPO, 'scripts', 'secret-scan.ts'), clean], { cwd: REPO, encoding: 'utf8' });
    expect(ok.status).toBe(0);
  }, 60_000);

  it('--staged judges only what is about to be committed, and an ignored file cannot fail it', () => {
    // A throwaway repository, so the hook's exact code path runs against a real index.
    const repo = tempDir('sec31-staged');
    const git = (...args: string[]): void => { expect(spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).status, args.join(' ')).toBe(0); };
    git('init', '-q');
    git('config', 'user.email', 'sec31@example.test');
    git('config', 'user.name', 'sec31');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env.local\n');
    // The correct place for a key. It must never be what fails the commit.
    fs.writeFileSync(path.join(repo, '.env.local'), `${['WORKBENCH', 'CRED', 'GOOGLE'].join('_')}=${assembled()}\n`);
    fs.writeFileSync(path.join(repo, 'fine.ts'), 'export const nothing = 1;\n');
    git('add', '-A');
    const script = path.join(REPO, 'scripts', 'secret-scan.ts');
    const clean = spawnSync(TSX, [TSX_ENTRY, script, '--staged', repo], { cwd: repo, encoding: 'utf8' });
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).toContain('staged file(s)');

    // Now the mistake this gate exists for: the key typed straight into a source file.
    fs.writeFileSync(path.join(repo, 'oops.ts'), `export const key = '${assembled()}';\n`);
    git('add', 'oops.ts');
    const bad = spawnSync(TSX, [TSX_ENTRY, script, '--staged', repo], { cwd: repo, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('oops.ts:1');
    expect(bad.stdout, 'the value itself is never printed').not.toContain(assembled());
  }, 60_000);
});
