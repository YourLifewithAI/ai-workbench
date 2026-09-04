import fs from 'node:fs';
import { STATE_FILE } from './global-setup.js';

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) return;
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { pid: number; ws: string };
  try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 1500));
  // Windows refuses to unlink a file another process still has open, and closing a handle there is not
  // instantaneous even after the process is gone — SQLite's database and the log are both open until it is.
  // `force` only swallows ENOENT, so without the retries this throws EBUSY and fails a suite that passed.
  // Nothing about the run depends on the temp directory going away, so a failure to remove it is reported
  // rather than raised.
  try {
    fs.rmSync(state.ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    process.stderr.write(`e2e teardown: could not remove ${state.ws}: ${(e as Error).message}\n`);
  }
  fs.rmSync(STATE_FILE, { force: true, maxRetries: 5, retryDelay: 100 });
}
