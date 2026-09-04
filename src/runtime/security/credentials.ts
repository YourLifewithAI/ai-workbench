// The only module that reads credentials: config/credentials.json (0600) or WORKBENCH_CRED_<NAME> (D-33).
// Also one of the two files allowed to read process.env (spec/architecture.md).
import fs from 'node:fs';
import { CredentialsFile } from '../../shared/workspace.js';
import type { Redactor } from './redaction.js';
import { WorkspaceError, formatZodError } from '../util/errors.js';

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
        notes.push(
          `${credentialsPath} holds your provider keys in plain text, and Windows has no POSIX mode bits for ` +
          'the runtime to enforce, so the file carries whatever permissions it inherited. Restrict it yourself: ' +
          `icacls "${credentialsPath}" /inheritance:r /grant:r "%USERNAME%:F"  — or keep keys in ` +
          'WORKBENCH_CRED_<NAME> instead. On Linux and macOS the runtime refuses to start unless the file is 0600.',
        );
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
