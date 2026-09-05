// The shipped model roles (D-68), read from defaults so a test that says "the model the capable role comes to
// under the mock" follows the list rather than restating it.
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './workspace.js';

const defaults = JSON.parse(fs.readFileSync(path.join(REPO, 'defaults', 'workbench.json'), 'utf8')) as { models: { roles: Record<string, string[]> } };

/** Under `--provider mock` every member is servable, so a role comes to its first entry. */
export function roleFirst(name: string): string {
  const list = defaults.models.roles[name];
  if (!list?.length) throw new Error(`defaults/workbench.json defines no models for the "${name}" role`);
  return list[0]!;
}
