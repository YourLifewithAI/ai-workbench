// Every file in the workspace that holds a secret — the credentials, the runtime token, the VAPID private key
// — is promised the same thing: only this account can read it. Three call sites used to each write that promise
// out longhand as `writeFileSync({ mode: 0o600 })` plus a `chmodSync`, and only one of them had been taught that
// on Windows those two lines are decoration. This module is the promise itself, so a new secret file gets it by
// construction rather than by whoever adds it remembering.
import fs from 'node:fs';
import path from 'node:path';
import { icaclsFix, inspect, restrict } from './windowsAcl.js';

export interface SecretFileResult {
  /** True only when this process verified the file is readable by this account alone. */
  protected: boolean;
  /** What was verified, or why it could not be — safe to log and to show an owner. */
  detail: string;
  /** The command that fixes it, when there is one. */
  fix?: string;
}

/** Creates the parent directory, writes the file, and restricts it to this account. Never throws on the ACL. */
export function writeSecretFile(file: string, contents: string): SecretFileResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The mode argument only applies when the file is created, so an existing file is corrected explicitly.
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return protectSecretFile(file);
}

/** The half that applies to a file already on disk. Split out so a repair path can call it alone. */
export function protectSecretFile(file: string): SecretFileResult {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
    const mode = fs.statSync(file).mode & 0o777;
    return mode & 0o077
      ? { protected: false, detail: `mode is ${mode.toString(8)}, not 0600`, fix: `chmod 600 "${file}"` }
      : { protected: true, detail: 'mode 0600' };
  }

  // chmod on Windows toggles the read-only bit and nothing else: it grants nothing and protects nothing. The
  // ACL is the protection, and it is applied on write rather than left for the owner to remember.
  const applied = restrict(file);
  if (applied.ok) return { protected: true, detail: applied.detail };

  // icacls failing does not mean the file is exposed — a workspace under the user's profile is already
  // restricted by inheritance. Ask before reporting, so the owner is told what is true rather than what failed.
  const acl = inspect(file);
  if (acl.restricted === true) return { protected: true, detail: `${acl.detail} (inherited; icacls: ${applied.detail})` };
  return { protected: false, detail: `${applied.detail}; ${acl.detail}`, fix: icaclsFix(file) };
}
