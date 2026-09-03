// Container entry (D-60): `node dist/server.js` reads WORKBENCH_* only through bootstrap and runs in the foreground.
import { readBootstrap } from './bootstrap.js';
import { runForeground } from './foreground.js';

const bootstrap = readBootstrap();
if (!bootstrap.workspace) {
  process.stderr.write('WORKBENCH_WORKSPACE must point at a workspace directory (create one with `workbench init <path>`).\n');
  process.exit(2);
}
runForeground({ workspaceDir: bootstrap.workspace, bootstrap }).then(
  () => process.exit(0),
  (e: unknown) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  },
);
