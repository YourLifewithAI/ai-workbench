// `workbench start` and the Docker entry share this: run until SIGTERM/SIGINT, then close cleanly (RUN-00 DoD 2).
import { spawn } from 'node:child_process';
import { Runtime, type RuntimeOptions } from './runtime.js';
import { childEnv } from './security/childEnv.js';

export interface ForegroundOptions extends RuntimeOptions { open?: boolean | undefined }

/** Prints exactly one stdout line (the tokened URL); everything else goes to stderr and the log. Resolves after shutdown. */
export async function runForeground(opts: ForegroundOptions): Promise<void> {
  const runtime = await Runtime.create(opts);
  const { url } = await runtime.start();
  process.stdout.write(url + '\n');

  if (opts.open) openBrowser(url, opts.bootstrap.childEnvAllowlist);

  await new Promise<void>((resolve) => {
    let closing = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (closing) return;
      closing = true;
      process.stderr.write(`\n${signal} received, shutting down…\n`);
      runtime.stop().then(resolve, (e: unknown) => {
        process.stderr.write(`shutdown error: ${(e as Error).message}\n`);
        resolve();
      });
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  });
}

function openBrowser(url: string, allowlist: Record<string, string>): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: childEnv(allowlist) });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is already printed; opening a browser is a convenience.
  }
}
