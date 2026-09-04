// Every file in the workspace that holds a secret — the credentials, the runtime token, the VAPID private key
// — is promised the same thing: only this account can read it. Three call sites used to each write that promise
// out longhand as `writeFileSync({ mode: 0o600 })` plus a `chmodSync`, and only one of them had been taught that
// on Windows those two lines are decoration. This module is the promise itself, so a new secret file gets it by
// construction rather than by whoever adds it remembering.
import fs from 'node:fs';
import path from 'node:path';
import { icaclsFix, inspect, restrict } from './windowsAcl.js';

export interface SecretFileResult {
  /** Whether this account alone can read the file, as far as this process could establish. */
  protected: boolean;
  /**
   * Whether that was *read back* rather than assumed. False when the protection was applied but the ACL could
   * not be parsed afterwards — icacls is localised, and an unfamiliar locale is not proof of exposure, but it
   * is not confirmation either. Always true on POSIX, where the mode can simply be stat'ed.
   */
  verified: boolean;
  /** What was established, or why it could not be — safe to log and to show an owner. */
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
      ? { protected: false, verified: true, detail: `mode is ${mode.toString(8)}, not 0600`, fix: `chmod 600 "${file}"` }
      : { protected: true, verified: true, detail: 'mode 0600' };
  }

  // chmod on Windows toggles the read-only bit and nothing else: it grants nothing and protects nothing. The
  // ACL is the protection, and it is applied on write rather than left for the owner to remember.
  const applied = restrict(file);
  // Then read it back, always — setting an ACL is the enforcement and reading it is the check, and this module
  // is not allowed to claim more than it verified. A successful icacls is also not the whole story in the
  // other direction: a workspace under the user's profile is already restricted by inheritance, so a *failed*
  // icacls does not mean the file is exposed. Only the ACL itself answers either question.
  const acl = inspect(file);
  if (acl.restricted === true) {
    return { protected: true, verified: true, detail: applied.ok ? acl.detail : `${acl.detail} (inherited; icacls: ${applied.detail})` };
  }
  if (acl.restricted === false) {
    return { protected: false, verified: true, detail: acl.detail, fix: icaclsFix(file) };
  }
  // The ACL could not be parsed. If icacls reported success the file is very probably fine, and refusing here
  // would strand an owner whose only fault is an unfamiliar locale — so this is protected-but-unconfirmed, and
  // the caller is told which.
  return applied.ok
    ? { protected: true, verified: false, detail: `${applied.detail}, but ${acl.detail}`, fix: icaclsFix(file) }
    : { protected: false, verified: true, detail: `${applied.detail}; ${acl.detail}`, fix: icaclsFix(file) };
}

/**
 * The same question, asked without changing anything — what `doctor` needs. `protectSecretFile` applies the
 * protection and is therefore the wrong thing to call from a read-only report.
 */
export function checkSecretFile(file: string): SecretFileResult {
  if (!fs.existsSync(file)) return { protected: true, verified: true, detail: 'not present' };
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    return mode & 0o077
      ? { protected: false, verified: true, detail: `mode ${mode.toString(8)}`, fix: `chmod 600 "${file}"` }
      : { protected: true, verified: true, detail: 'mode 0600' };
  }
  const acl = inspect(file);
  if (acl.restricted === true) return { protected: true, verified: true, detail: acl.detail };
  if (acl.restricted === false) return { protected: false, verified: true, detail: acl.detail, fix: icaclsFix(file) };
  // Unparseable reads as a finding here on purpose: `doctor` exists to say what it could not confirm.
  return { protected: false, verified: false, detail: acl.detail, fix: icaclsFix(file) };
}
