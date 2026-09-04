// SEC-05, the half that is not about HTTP: the files in a workspace that hold secrets are readable only by
// the account that owns them. On POSIX that is a mode; on Windows it is an ACL. Both are asserted here by
// actually exposing a file to another principal and watching the check notice.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { checkSecretFile, writeSecretFile } from '../../src/runtime/security/secretFile.js';

const WINDOWS = process.platform === 'win32';

function tempFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-secret-')), name);
}

describe('SEC-05 a secret file is readable only by this account', () => {
  it('writes one that way, on whichever platform this is', () => {
    const file = tempFile('credentials.json');
    const written = writeSecretFile(file, '{"google":{"apiKey":"not-a-real-key"}}\n');
    expect(written.protected, written.detail).toBe(true);
    expect(checkSecretFile(file).protected).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('not-a-real-key');
  });

  it('creates the parent directory rather than assuming it exists', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-secret-')), 'data', 'runtime.token');
    expect(writeSecretFile(file, 'token').protected).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('token');
  });

  it('says a file another principal can read is not protected', () => {
    const file = tempFile('exposed.json');
    writeSecretFile(file, 'secret');
    if (WINDOWS) {
      // Grant the Everyone group read access. `*S-1-1-0` is that group's SID, which is the same on every
      // Windows however the account names are localised — the name "Everyone" is not.
      execFileSync('icacls', [file, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore', windowsHide: true });
    } else {
      fs.chmodSync(file, 0o644);
    }
    const check = checkSecretFile(file);
    expect(check.protected, `after opening it up: ${check.detail}`).toBe(false);
    expect(check.fix, 'and it says how to fix it').toBeTruthy();
  });

  it('a file that is not there is not a finding', () => {
    expect(checkSecretFile(tempFile('never-written.json')).protected).toBe(true);
  });
});
