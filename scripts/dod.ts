// `npm run dod -- nn`: runs the Definition-of-done suite for one run (tests/dod/RUN-nn.test.ts).
// Builds dist/ first when the suite needs the packaged bin and it is missing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
if (!arg || !/^\d{1,2}$/.test(arg)) {
  process.stderr.write('usage: npm run dod -- <nn>   e.g. npm run dod -- 00\n');
  process.exit(2);
}
const nn = arg.padStart(2, '0');
const suite = path.join('tests', 'dod', `RUN-${nn}.test.ts`);
if (!fs.existsSync(path.join(root, suite))) {
  process.stderr.write(`dod: no suite at ${suite}\n`);
  process.exit(2);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (!fs.existsSync(path.join(root, 'dist', 'cli.js')) || !fs.existsSync(path.join(root, 'dist', 'ui', 'index.html'))) {
  process.stdout.write('dod: dist/ is missing, running `npm run build` first\n');
  const build = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, ['vitest', 'run', '--project', 'dod', suite], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
