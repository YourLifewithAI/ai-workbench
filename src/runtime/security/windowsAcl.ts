// Windows has no POSIX mode bits, so the 0600 the credentials file is promised has to come from an ACL.
// This module is the only place that shells out to icacls, and it is deliberately small: setting the ACL is
// the enforcement, reading it back is the check, and neither is allowed to claim more than it verified.
import { execFileSync } from 'node:child_process';
import os from 'node:os';

export interface AclCheck {
  /** null when the ACL could not be read at all — unknown is not the same as safe. */
  restricted: boolean | null;
  /** Principals with an entry, as icacls named them. Empty when the output could not be parsed. */
  principals: string[];
  detail: string;
}

/** The command an owner can run themselves; also what this module runs. Quoted for cmd.exe. */
export function icaclsFix(file: string): string {
  return `icacls "${file}" /inheritance:r /grant:r "${os.userInfo().username}:F"`;
}

/**
 * Strip every inherited entry and grant the current user alone. `/inheritance:r` is the half that matters:
 * without it the file keeps whatever the parent directory hands out, which on a default Windows profile
 * includes SYSTEM and Administrators.
 */
export function restrict(file: string): { ok: boolean; detail: string } {
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10_000,
    });
    return { ok: true, detail: 'restricted to this user' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.split('\n')[0] ?? 'icacls failed' };
  }
}

/**
 * Read the ACL back. Returns `restricted: null` when the output cannot be parsed — icacls is localised, and a
 * parser that guesses on an unfamiliar locale would either lock the owner out of their own workspace or, far
 * worse, report a file safe because it failed to find anything alarming in a language it does not read.
 */
export function inspect(file: string): AclCheck {
  let out: string;
  try {
    out = execFileSync('icacls', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10_000 });
  } catch (e) {
    return { restricted: null, principals: [], detail: `icacls could not read the ACL: ${(e as Error).message.split('\n')[0]}` };
  }

  // Lines look like `C:\path\file NT AUTHORITY\SYSTEM:(F)` then continuation lines `                 BUILTIN\Users:(RX)`.
  const principals: string[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(file, '').trim();
    if (!line) continue;
    const m = /^(.+?):\([^)]*\)/.exec(line);
    if (m?.[1]) principals.push(m[1].trim());
  }
  if (principals.length === 0) {
    return { restricted: null, principals: [], detail: 'the ACL could not be parsed on this system' };
  }

  const me = os.userInfo().username.toLowerCase();
  // A principal is ours if the account part after any DOMAIN\ or MACHINE\ prefix is this user.
  const foreign = principals.filter((p) => (p.split('\\').pop() ?? p).trim().toLowerCase() !== me);
  return {
    restricted: foreign.length === 0,
    principals,
    detail: foreign.length === 0 ? 'this user only' : `also readable by ${foreign.join(', ')}`,
  };
}
