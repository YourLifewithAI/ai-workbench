// `workbench` (D-45): init/start/doctor act locally; everything else is an HTTP client of the runtime.
import { Command } from 'commander';
import { readBootstrap } from '../bootstrap.js';
import { packagePaths } from '../paths.js';
import { registerInit } from './commands/init.js';
import { registerStart } from './commands/start.js';
import { registerDoctor } from './commands/doctor.js';
import { registerRun } from './commands/run.js';
import { registerRuns } from './commands/runs.js';
import { registerTrace } from './commands/trace.js';
import { registerDev } from './commands/dev.js';
import { registerLibrary } from './commands/library.js';
import { registerMemory } from './commands/memory.js';
import { registerEvaluate } from './commands/evaluate.js';
import { registerCredentials, registerPlugins } from './commands/transfer.js';
import { registerReview, registerSchedules } from './commands/review.js';
import { registerApprovals, registerTools } from './commands/approvals.js';

let bootstrap;
try {
  bootstrap = readBootstrap();
} catch (e) {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exit(2);
}

const program = new Command('workbench')
  .description('AI Workbench: a local-first, model-agnostic runtime for automated agent workflows')
  .version(packagePaths().version)
  .option('--workspace <path>', 'workspace directory (else WORKBENCH_WORKSPACE, else the current directory)')
  .option('--json', 'machine-readable output')
  .showHelpAfterError();

registerInit(program);
registerStart(program, bootstrap);
registerDoctor(program, bootstrap);
registerRun(program, bootstrap);
registerRuns(program, bootstrap);
registerTrace(program, bootstrap);
registerDev(program, bootstrap);
registerLibrary(program, bootstrap);
registerMemory(program, bootstrap);
registerEvaluate(program, bootstrap);
registerPlugins(program, bootstrap);
registerCredentials(program, bootstrap);
registerReview(program, bootstrap);
registerSchedules(program, bootstrap);
registerApprovals(program, bootstrap);
registerTools(program, bootstrap);

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exit(1);
});
