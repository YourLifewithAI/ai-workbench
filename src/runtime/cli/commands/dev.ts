// `workbench dev`: the runtime plus Vite with HMR, so UI work does not need a rebuild per change.
// Vite serves the SPA and proxies /api to the runtime, which is told to accept the Vite origin.
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import { packagePaths } from '../../paths.js';
import { Runtime } from '../../runtime.js';
import { childEnv } from '../../security/childEnv.js';
import { CliError } from '../client.js';
import { err, guarded, out, resolveWorkspace } from '../context.js';

interface DevOptions { port?: string; uiPort?: string; provider?: string }

export function registerDev(program: Command, bootstrap: Bootstrap): void {
  program
    .command('dev')
    .description('run the workbench with a hot-reloading UI (Vite dev server in front of the runtime)')
    .option('--port <n>', 'runtime port (0 = OS-assigned; default 0 in dev)')
    .option('--ui-port <n>', 'Vite port (default 5173, or the next free port)')
    .option('--provider <name>', '"mock" makes every run this runtime starts use the mock provider')
    .action(async (opts: DevOptions, cmd: Command) =>
      guarded(async () => {
        const workspaceDir = resolveWorkspace(cmd, bootstrap);
        if (opts.provider !== undefined && opts.provider !== 'mock') throw new CliError(`--provider accepts only "mock" (got "${opts.provider}")`);
        const pkg = packagePaths();

        // Vite's port is decided first so the runtime can accept it as a Host and Origin before either starts.
        const uiPort = opts.uiPort !== undefined ? Number(opts.uiPort) : await freePort(5173);
        if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535) throw new CliError(`--ui-port must be a port number, got "${opts.uiPort}"`);

        const runtime = await Runtime.create({
          workspaceDir,
          bootstrap,
          port: opts.port !== undefined ? Number(opts.port) : 0,
          providerOverride: opts.provider === 'mock' ? 'mock' : null,
          expose: [`127.0.0.1:${uiPort}`, `localhost:${uiPort}`],
        });
        const { port } = await runtime.start();

        const vite = spawn(
          process.execPath,
          [require_resolve_vite(pkg.root), '--port', String(uiPort), '--strictPort'],
          {
            cwd: pkg.root,
            stdio: ['ignore', 'inherit', 'inherit'],
            env: childEnv(bootstrap.childEnvAllowlist, { WB_DEV_API: `http://127.0.0.1:${port}`, FORCE_COLOR: '1' }),
          },
        );
        out(`http://localhost:${uiPort}/#token=${runtime.token}`);
        err(`runtime on 127.0.0.1:${port} · workspace ${workspaceDir} · edits to src/ui reload live`);

        await new Promise<void>((resolve) => {
          let closing = false;
          const shutdown = (): void => {
            if (closing) return;
            closing = true;
            vite.kill('SIGTERM');
            runtime.stop().then(resolve, resolve);
          };
          vite.on('exit', shutdown);
          process.once('SIGTERM', shutdown);
          process.once('SIGINT', shutdown);
        });
      }),
    );
}

function require_resolve_vite(root: string): string {
  return `${root}/node_modules/vite/bin/vite.js`;
}

/** First free port at or after `start`, so two dev sessions do not fight over 5173. */
async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 50; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(p, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new CliError(`No free port between ${start} and ${start + 50}.`);
}
