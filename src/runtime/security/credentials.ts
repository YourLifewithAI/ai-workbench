// The only module that reads credentials: config/credentials.json (0600) or WORKBENCH_CRED_<NAME> (D-33).
// Also one of the two files allowed to read process.env (spec/architecture.md).
import fs from 'node:fs';
import { CredentialsFile } from '../../shared/workspace.js';
import type { Redactor } from './redaction.js';
import { WorkspaceError, formatZodError } from '../util/errors.js';
import { icaclsFix, inspect } from './windowsAcl.js';

export interface Credentials {
  get(name: string): string | undefined;
  names(): string[];
  /**
   * Re-reads the file. The Settings editor writes a key while the runtime is running, and until this is called
   * the runtime neither knows the key exists nor redacts it — which would put a freshly saved key into the next
   * trace. Everything holds this object rather than a snapshot of it, so a reload reaches all of them.
   */
  reload(): void;
  /**
   * What this platform cannot enforce. POSIX mode bits are the whole protection on the credentials file, and
   * Windows has none, so on Windows a configured key sits in a file with whatever ACL it inherited. Silently
   * skipping the check made the runtime claim a protection it was not providing; `doctor` reads this instead.
   */
  warnings(): string[];
}

export function loadCredentials(credentialsPath: string, redactor: Redactor): Credentials {
  const values = new Map<string, string>();
  const notes: string[] = [];
  read();

  return {
    get: (name) => values.get(name.toLowerCase()),
    names: () => [...values.keys()].sort(),
    reload: () => read(),
    warnings: () => [...notes],
  };

  function read(): void {
    values.clear();
    notes.length = 0;
    if (fs.existsSync(credentialsPath)) {
      if (process.platform === 'win32') {
        // Windows has no mode bits, so the ACL is the protection and this is where it is checked. A file another
        // principal can read is refused exactly as an 0644 file is on Linux — the promise is the same promise.
        const acl = inspect(credentialsPath);
        if (acl.restricted === false) {
          throw new WorkspaceError(credentialsPath, `must be readable only by you; it is ${acl.detail}. Fix: ${icaclsFix(credentialsPath)}`);
        }
        if (acl.restricted === null) {
          // Unknown is not safe, but it is also not proof of exposure, and refusing to start over an unreadable
          // ACL would strand an owner whose only fault is an unfamiliar locale. Say so instead, loudly.
          notes.push(`${acl.detail}. The runtime cannot confirm ${credentialsPath} is restricted to you. Run: ${icaclsFix(credentialsPath)}`);
        }
      } else {
        const mode = fs.statSync(credentialsPath).mode & 0o777;
        if (mode & 0o077) {
          throw new WorkspaceError(credentialsPath, `must be readable only by you (mode 0600); it is ${mode.toString(8)}. Fix: chmod 600 "${credentialsPath}"`);
        }
      }
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      } catch (e) {
        throw new WorkspaceError(credentialsPath, `not valid JSON: ${(e as Error).message}`);
      }
      const parsed = CredentialsFile.safeParse(raw);
      if (!parsed.success) throw formatZodError(credentialsPath, parsed.error);
      for (const [name, entry] of Object.entries(parsed.data)) values.set(name.toLowerCase(), entry.apiKey);
    }

    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('WORKBENCH_CRED_') && v) values.set(k.slice('WORKBENCH_CRED_'.length).toLowerCase(), v);
    }

    // Registering is additive: a key that has been removed from the file stays redacted for the rest of this
    // process's life, which is the safe direction — an old key in an old trace is still a key.
    for (const [name, value] of values) redactor.register(`credential:${name}`, value);
  }
}
