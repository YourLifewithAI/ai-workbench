// `--live <adapter>` arrives as WB_LIVE_ADAPTERS from scripts/contract.ts; the credential comes from the
// same place the runtime reads it, so a live run needs no second way to hold a key.
import path from 'node:path';
import { Redactor } from '../../src/runtime/security/redaction.js';
import { loadCredentials } from '../../src/runtime/security/credentials.js';
import { packagePaths, workspacePaths } from '../../src/runtime/paths.js';

export function liveAdapters(): string[] {
  const raw = readEnv('WB_LIVE_ADAPTERS');
  if (readEnv('WB_LIVE') === '1' && !raw) return ['google'];
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export function liveCredential(name: string): string | undefined {
  const workspace = readEnv('WORKBENCH_WORKSPACE');
  const credentialsPath = workspace ? workspacePaths(workspace).credentialsJson : path.join(packagePaths().root, 'no-such-workspace', 'credentials.json');
  return loadCredentials(credentialsPath, new Redactor()).get(name);
}

/** The lint boundary keeps process.env to bootstrap and the credentials loader; test helpers are outside src/. */
function readEnv(name: string): string | undefined {
  return process.env[name];
}
