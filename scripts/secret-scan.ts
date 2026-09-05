// `npm run secret-scan`: the check gate fails when a key-shaped string is committed anywhere in the repo (SEC-31).
// Usage: tsx scripts/secret-scan.ts [dir]        every file under dir (defaults to the repository root)
//        tsx scripts/secret-scan.ts --staged     only what is staged, as the pre-commit hook runs it
//
// --staged reads the git index rather than the filesystem, which matters in both directions: `.env.local`
// — the correct place for a key, and gitignored — is never flagged, and an ignored file can never fail the
// check. The value itself is never printed; the point is to say where it is, not to copy it somewhere else.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanDirectory, scanText, type Finding } from '../src/runtime/security/secretScan.js';

const staged = process.argv.includes('--staged');
const dirArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const root = dirArg ? path.resolve(dirArg) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exclude = new Set(['node_modules', '.git', 'spec', 'coverage', 'test-results', 'playwright-report', 'dist']);

let findings: Finding[];
let scope: string;
if (staged) {
  const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  findings = files.flatMap((file) => {
    const full = path.join(root, file);
    // A staged rename or deletion can name a path that is no longer on disk.
    return fs.existsSync(full) ? scanText(fs.readFileSync(full, 'utf8'), file) : [];
  });
  scope = `${files.length} staged file(s)`;
} else {
  findings = scanDirectory(root, exclude);
  scope = root;
}
if (findings.length === 0) {
  process.stdout.write(`secret-scan: clean (${scope})\n`);
  process.exit(0);
}
for (const f of findings) process.stdout.write(`secret-scan: ${f.file}:${f.line} looks like a ${f.pattern}\n`);
process.stdout.write(`secret-scan: ${findings.length} finding(s). Remove the value, rotate the key, and load it via config/credentials.json or WORKBENCH_CRED_<NAME>.\n`);
process.exit(1);
