// `npm run contract [-- --live <adapter>[,<adapter>]]`. Without --live every real adapter replays its recorded
// HTTP, so the suite is green in CI with no keys; with it, the same suite records fresh exchanges (model-layer.md).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const adapters: string[] = [];
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--live') {
    const value = argv[++i];
    if (!value) {
      process.stderr.write('usage: npm run contract -- --live <adapter>[,<adapter>]\n');
      process.exit(2);
    }
    adapters.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
  } else {
    rest.push(argv[i]!);
  }
}

if (adapters.length) {
  process.stdout.write(`contract: live against ${adapters.join(', ')} — recorded exchanges will be rewritten\n`);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, ['vitest', 'run', '--project', 'contract', ...rest], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ...(adapters.length ? { WB_LIVE_ADAPTERS: adapters.join(',') } : {}) },
});
process.exit(result.status ?? 1);
