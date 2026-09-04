// "Readable only by this account" is one promise with two implementations, so the assertion for it is one
// helper with two branches rather than a mode check copied into every suite — a mode check is what fails on
// Windows, where Node reports 0666 for any writable file and 0600 can never be observed.
import fs from 'node:fs';
import { expect } from 'vitest';
import { inspect } from '../../src/runtime/security/windowsAcl.js';

export function expectRestricted(file: string): void {
  expect(fs.existsSync(file), `${file} exists`).toBe(true);
  if (process.platform === 'win32') {
    const acl = inspect(file);
    // `restricted: null` means the ACL could not be read. That is not proof of exposure, but it is also not
    // the verification this test exists to make, so it fails and says which of the two happened.
    expect(acl.restricted, `${file}: ${acl.detail} (${acl.principals.join(', ') || 'no principals parsed'})`).toBe(true);
  } else {
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode.toString(8), `${file} mode`).toBe('600');
  }
}
