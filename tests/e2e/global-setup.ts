// Starts one runtime (mock provider) on an OS-assigned port from a temp workspace and seeds it with a run through the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_FILE = path.join(root, 'test-results', 'e2e-runtime.json');

export default async function globalSetup(): Promise<void> {
  const cli = path.join(root, 'dist', 'cli.js');
  if (!fs.existsSync(cli) || !fs.existsSync(path.join(root, 'dist', 'ui', 'index.html'))) {
    throw new Error('dist/ is missing: run `npm run build` before `npm run e2e`.');
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('WORKBENCH_')) env[k] = v;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'));
  const init = spawnSync(process.execPath, [cli, 'init', ws, '--name', 'e2e'], { env, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);

  const child = spawn(process.execPath, [cli, 'start', '--workspace', ws, '--port', '0', '--provider', 'mock'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); const nl = out.indexOf('\n'); if (nl !== -1) resolve(out.slice(0, nl)); });
    child.on('exit', (code) => reject(new Error(`runtime exited (${code}): ${stderr}`)));
    setTimeout(() => reject(new Error('runtime did not print its URL in time')), 30_000);
  });
  const seed = spawnSync(process.execPath, [cli, 'run', 'agent', 'echo', '--input', 'seed run from e2e setup', '--json', '--workspace', ws], { env, encoding: 'utf8' });
  if (seed.status !== 0) throw new Error(`seed run failed: ${seed.stderr}`);
  const { runId } = JSON.parse(seed.stdout) as { runId: string };

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ url, pid: child.pid, ws, runId }));
  process.env['WB_E2E_URL'] = url;
  process.env['WB_E2E_RUN_ID'] = runId;
  process.env['WB_E2E_WS'] = ws;
  process.env['WB_E2E_CLI'] = cli;
}
