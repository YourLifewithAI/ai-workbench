// `npm run dod -- nn`: runs the Definition-of-done suite for one run (tests/dod/RUN-nn.test.ts).
// Builds dist/ first when the suite needs the packaged bin and it is missing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { binEntry } from './node-bin.js';
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
// npm has no importable entry to point at the way vitest and playwright do, so this one goes through the
// shell on Windows. Safe here and nowhere else: the arguments are two literals, and this is a build step
// rather than a boundary — the sandbox launcher deliberately does not take this shortcut.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (!fs.existsSync(path.join(root, 'dist', 'cli.js')) || !fs.existsSync(path.join(root, 'dist', 'ui', 'index.html'))) {
  process.stdout.write('dod: dist/ is missing, running `npm run build` first\n');
  const build = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const unit = spawnSync(process.execPath, [binEntry('vitest'), 'run', '--project', 'dod', suite], { cwd: root, stdio: 'inherit' });
if (unit.status !== 0) process.exit(unit.status ?? 1);

// The brief's DoD also names browser cases; they are tagged `@run-nn` in tests/e2e (spec/api-and-cli.md §Gates).
const tag = `@run-${nn}`;
const tagged = fs.readdirSync(path.join(root, 'tests', 'e2e'))
  .some((f) => f.endsWith('.spec.ts') && fs.readFileSync(path.join(root, 'tests', 'e2e', f), 'utf8').includes(tag));
if (!tagged) {
  process.stdout.write(`dod: no e2e case tagged ${tag}\n`);
  process.exit(0);
}
process.stdout.write(`dod: running the e2e cases tagged ${tag}\n`);
const e2e = spawnSync(process.execPath, [binEntry('@playwright/test', 'playwright'), 'test', '--grep', tag], { cwd: root, stdio: 'inherit' });
process.exit(e2e.status ?? 1);
