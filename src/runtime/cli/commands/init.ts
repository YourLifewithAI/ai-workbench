import path from 'node:path';
import type { Command } from 'commander';
import { packagePaths } from '../../paths.js';
import { initWorkspace } from '../../workspace/loader.js';
import { expandHome, guarded, out, outJson, wantsJson } from '../context.js';

export function registerInit(program: Command): void {
  program
    .command('init <path>')
    .description('create a workspace (example echo agent, mock fixtures, default config)')
    .option('--name <name>', 'workspace name (defaults to the directory name)')
    .action(async (target: string, opts: { name?: string }, cmd: Command) =>
      guarded(async () => {
        const pkg = packagePaths();
        const paths = initWorkspace(path.resolve(expandHome(target)), pkg.examplesWorkspace, pkg.defaults, opts.name);
        if (wantsJson(cmd)) return outJson({ workspace: paths.dir });
        out(`Workspace created at ${paths.dir}`);
        out(`Next: workbench start --workspace "${paths.dir}"   (or: workbench run agent echo --input hi --workspace "${paths.dir}")`);
      }),
    );
}
