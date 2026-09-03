import fs from 'node:fs';
import { STATE_FILE } from './global-setup.js';

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) return;
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { pid: number; ws: string };
  try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(state.ws, { recursive: true, force: true });
  fs.rmSync(STATE_FILE, { force: true });
}
