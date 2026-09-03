import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import { runForeground } from '../../foreground.js';
import { CliError } from '../client.js';
import { guarded, resolveWorkspace } from '../context.js';

interface StartOptions { port?: string; bind?: string; open?: boolean; provider?: string; expose?: string[] }

export function registerStart(program: Command, bootstrap: Bootstrap): void {
  program
    .command('start')
    .description('run the workbench in the foreground; prints the tokened URL once')
    .option('--port <n>', 'port to listen on (0 = OS-assigned); default 8787 or WORKBENCH_PORT')
    .option('--bind <host>', 'address to bind; default 127.0.0.1 or WORKBENCH_BIND')
    .option('--open', 'open the URL in a browser')
    .option('--provider <name>', '"mock" makes every run this runtime starts use the mock provider')
    .option('--expose <origin>', 'accept this extra Host/Origin (repeatable), e.g. a tailnet hostname', collect, [])
    .action(async (opts: StartOptions, cmd: Command) =>
      guarded(async () => {
        const workspaceDir = resolveWorkspace(cmd, bootstrap);
        let port: number | undefined;
        if (opts.port !== undefined) {
          port = Number(opts.port);
          if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`--port must be an integer between 0 and 65535, got "${opts.port}"`);
        }
        if (opts.provider !== undefined && opts.provider !== 'mock') throw new CliError(`--provider accepts only "mock" (got "${opts.provider}")`);
        await runForeground({
          workspaceDir,
          bootstrap,
          port,
          bind: opts.bind,
          open: opts.open,
          providerOverride: opts.provider === 'mock' ? 'mock' : null,
          expose: opts.expose ?? [],
        });
      }),
    );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
