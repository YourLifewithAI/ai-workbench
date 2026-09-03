// The in-repo secret scanner (spec/api-and-cli.md §Gates). Also used by SEC-31.
import fs from 'node:fs';
import path from 'node:path';

export interface SecretPattern { name: string; regex: RegExp }
export const PATTERNS: SecretPattern[] = [
  { name: 'google-api-key', regex: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: 'anthropic-key', regex: /sk-ant-[0-9A-Za-z_-]{40,}/g },
  { name: 'openai-key', regex: /sk-[0-9A-Za-z]{40,}/g },
  { name: 'github-token', regex: /ghp_[0-9A-Za-z]{36,}/g },
  { name: 'slack-token', regex: /xox[abp]-[0-9A-Za-z-]{20,}/g },
  { name: 'workbench-cred-env', regex: /WORKBENCH_CRED_[A-Z]+=\S{16,}/g },
];

export interface Finding { file: string; line: number; pattern: string }

export function scanText(text: string, file = '<text>'): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      p.regex.lastIndex = 0;
      if (p.regex.test(line)) findings.push({ file, line: i + 1, pattern: p.name });
    }
  });
  return findings;
}

const DEFAULT_EXCLUDE = new Set(['node_modules', '.git', 'spec', 'coverage', 'test-results', 'playwright-report']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.sqlite', '.zip', '.gz']);

export function scanDirectory(root: string, exclude: Set<string> = DEFAULT_EXCLUDE, maxBytes = 2_000_000): Finding[] {
  const findings: Finding[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (exclude.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        if (BINARY_EXT.has(path.extname(entry.name))) continue;
        const stat = fs.statSync(full);
        if (stat.size > maxBytes) continue;
        findings.push(...scanText(fs.readFileSync(full, 'utf8'), path.relative(root, full)));
      }
    }
  };
  walk(root);
  return findings;
}
