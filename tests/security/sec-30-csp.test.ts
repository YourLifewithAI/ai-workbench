// SEC-30: strict CSP on HTML and API responses; dist/ui loads nothing from another origin.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CSP } from '../../src/runtime/security/auth.js';
import { REPO, startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';
import { binEntry } from '../../scripts/node-bin.js';

const uiDist = path.join(REPO, 'dist', 'ui');
let rt: Started;

beforeAll(async () => {
  if (!fs.existsSync(path.join(uiDist, 'index.html'))) {
    const r = spawnSync(process.execPath, [binEntry('vite'), 'build'], { cwd: REPO, stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`vite build failed (status ${r.status}): ${r.stderr?.toString() ?? r.error?.message ?? 'no output'}`);
  }
  rt = await startRuntime(tempWorkspace('sec30'));
}, 120_000);
afterAll(async () => { await rt.stop(); });

// Documentation and namespace URLs that are not loads.
const NOT_LOADS = [/^https?:\/\/(www\.)?w3\.org\//, /^https?:\/\/(www\.)?tailwindcss\.com/, /^https?:\/\/react\.dev/, /^https?:\/\/(www\.)?reactjs\.org/, /^https?:\/\/github\.com\//, /^https?:\/\/tanstack\.com/, /^https?:\/\/(www\.)?remix\.run/, /^https?:\/\/reactrouter\.com/, /^https?:\/\/(www\.)?apache\.org/, /^https?:\/\/developer\.mozilla\.org/, /^https?:\/\/unpkg\.com\/@?tanstack/, /^https?:\/\/eslint\.org/, /^https?:\/\/fb\.me/, /^https?:\/\/facebook\.github\.io/, /^https?:\/\/feross\.org/];
const LOAD_CONTEXT = /(?:fetch\s*\(|new\s+WebSocket\s*\(|new\s+EventSource\s*\(|import\s*\(|\bsrc\s*=\s*|\bhref\s*=\s*|url\s*\()\s*["'`]?\s*$/;

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('SEC-30 content security policy', () => {
  it('sends the strict CSP and hardening headers on HTML, API, and error responses', async () => {
    for (const p of ['/', '/runs', '/api/v1/health', '/api/v1/runs', '/api/v1/nothing']) {
      const res = await fetch(`${rt.baseUrl}${p}`);
      expect(res.headers.get('content-security-policy'), p).toBe(CSP);
      expect(res.headers.get('x-content-type-options'), p).toBe('nosniff');
      expect(res.headers.get('x-frame-options'), p).toBe('DENY');
      expect(res.headers.get('referrer-policy'), p).toBe('no-referrer');
    }
    expect(CSP).toMatch(/default-src 'self'/);
    expect(CSP).toMatch(/frame-ancestors 'none'/);
    expect(CSP).not.toMatch(/unsafe-eval/);
    const html = await (await fetch(`${rt.baseUrl}/`)).text();
    expect(html).toContain('<div id="root">');
    expect(/<script(?![^>]*\bsrc=)[^>]*>[^<]/.test(html), 'no inline script in index.html').toBe(false);
  });

  it('dist/ui contains no load from another origin', () => {
    const offenders: string[] = [];
    for (const file of listFiles(uiDist)) {
      if (!/\.(js|mjs|css|html|webmanifest)$/.test(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
        const url = m[0];
        if (NOT_LOADS.some((re) => re.test(url))) continue;
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        if (LOAD_CONTEXT.test(before) || /^https?:\/\/[^/]+\.(js|css|woff2?|ttf|png|svg)(\?|$)/.test(url)) offenders.push(`${path.relative(REPO, file)}: ${url}`);
      }
      if (file.endsWith('.html')) {
        for (const m of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) if (/^(https?:)?\/\//.test(m[1]!)) offenders.push(`${path.relative(REPO, file)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
