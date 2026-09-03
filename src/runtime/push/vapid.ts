// VAPID keys identify this workspace to a push service. They are generated once at `init` and live in the
// workspace at 0600, next to the runtime token: whoever holds them can send notifications as this workbench.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { Redactor } from '../security/redaction.js';

export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

/** `mailto:` is what the push services want as a contact; nothing is ever sent to it by this runtime. */
const DEFAULT_SUBJECT = 'mailto:workbench@localhost';

export function vapidPath(workspaceDir: string): string {
  return path.join(workspaceDir, 'data', 'vapid.json');
}

/** Generates the pair once. A workspace that already has one keeps it: rotating would silently deafen every device. */
export function ensureVapidKeys(workspaceDir: string, redactor?: Redactor): VapidKeys {
  const file = vapidPath(workspaceDir);
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as VapidKeys;
    redactor?.register('vapid', existing.privateKey);
    return existing;
  }
  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey, subject: DEFAULT_SUBJECT };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  // An existing file's mode is not changed by writeFileSync, so say it explicitly for a file that already was.
  fs.chmodSync(file, 0o600);
  redactor?.register('vapid', keys.privateKey);
  return keys;
}
