// `workbench start` and the Docker entry share this: run until a stop signal, then close cleanly (RUN-00 DoD 2).
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
    // Windows has no SIGTERM: another process calling `kill` there is TerminateProcess, and no handler runs.
    // What it does deliver is Ctrl-C as SIGINT and Ctrl-Break as SIGBREAK, so the second one is listened for
    // too — those are the two ways an owner actually stops a foreground runtime on that platform. A hard
    // termination leaves `runtime.json` and `runtime.token` behind; the next command notices the runtime is
    // not answering and removes them (`findLiveRuntime`), which is why a missed handler is untidy, not unsafe.
    if (process.platform === 'win32') process.once('SIGBREAK', onSignal);
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
