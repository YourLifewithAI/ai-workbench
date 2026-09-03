// The only module that reads credentials: config/credentials.json (0600) or WORKBENCH_CRED_<NAME> (D-33).
// Also one of the two files allowed to read process.env (spec/architecture.md).
import fs from 'node:fs';
import { CredentialsFile } from '../../shared/workspace.js';
import type { Redactor } from './redaction.js';
import { WorkspaceError, formatZodError } from '../util/errors.js';

export interface Credentials {
  get(name: string): string | undefined;
  names(): string[];
}

export function loadCredentials(credentialsPath: string, redactor: Redactor): Credentials {
  const values = new Map<string, string>();

  if (fs.existsSync(credentialsPath)) {
    if (process.platform !== 'win32') {
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

  for (const [name, value] of values) redactor.register(`credential:${name}`, value);

  return {
    get: (name) => values.get(name.toLowerCase()),
    names: () => [...values.keys()].sort(),
  };
}
