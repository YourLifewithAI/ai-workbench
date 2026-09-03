// `npm run secret-scan`: the check gate fails when a key-shaped string is committed anywhere in the repo (SEC-31).
// Usage: tsx scripts/secret-scan.ts [dir]   (defaults to the repository root)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDirectory } from '../src/runtime/security/secretScan.js';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exclude = new Set(['node_modules', '.git', 'spec', 'coverage', 'test-results', 'playwright-report', 'dist']);
const findings = scanDirectory(root, exclude);
if (findings.length === 0) {
  process.stdout.write(`secret-scan: clean (${root})\n`);
  process.exit(0);
}
for (const f of findings) process.stdout.write(`secret-scan: ${f.file}:${f.line} looks like a ${f.pattern}\n`);
process.stdout.write(`secret-scan: ${findings.length} finding(s). Remove the value, rotate the key, and load it via config/credentials.json or WORKBENCH_CRED_<NAME>.\n`);
process.exit(1);
