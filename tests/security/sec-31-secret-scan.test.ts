// SEC-31: the check-gate secret scanner catches a key assembled at test time in a temp directory.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { scanDirectory, scanText } from '../../src/runtime/security/secretScan.js';
import { REPO, TSX, tempDir } from '../helpers/workspace.js';

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
    const bad = spawnSync(TSX, [path.join(REPO, 'scripts', 'secret-scan.ts'), dirty], { cwd: REPO, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('oops.ts:1');
    const clean = tempDir('sec31-clean');
    fs.writeFileSync(path.join(clean, 'fine.ts'), 'export const nothing = 1;\n');
    const ok = spawnSync(TSX, [path.join(REPO, 'scripts', 'secret-scan.ts'), clean], { cwd: REPO, encoding: 'utf8' });
    expect(ok.status).toBe(0);
  }, 60_000);
});
