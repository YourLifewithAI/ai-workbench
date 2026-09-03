import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import { packagePaths, workspacePaths } from '../../paths.js';
import { loadWorkspace } from '../../workspace/loader.js';
import { loadCredentials } from '../../security/credentials.js';
import { Redactor } from '../../security/redaction.js';
import { defaultAssertFts5 } from '../../db/index.js';
import { findExecutable } from '../../util/exec.js';
import { findLiveRuntime } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

interface Check { name: string; ok: boolean; detail: string }

export function registerDoctor(program: Command, bootstrap: Bootstrap): void {
  program
    .command('doctor')
    .description('check the workspace, database features, credentials, and sandbox prerequisites')
    .action(async (_opts: unknown, cmd: Command) =>
      guarded(async () => {
        const checks: Check[] = [];
        const pkg = packagePaths();
        checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: `v${process.versions.node} (need >= 22)` });

        let workspaceOk = false;
        let workspaceDir: string | null = null;
        try {
          workspaceDir = resolveWorkspace(cmd, bootstrap);
          const ws = loadWorkspace(workspaceDir, pkg.defaults);
          workspaceOk = true;
          const broken = ws.brokenAgents.map((b) => `${b.id}: ${b.message}`);
          checks.push({ name: 'workspace', ok: true, detail: `${ws.paths.dir} ("${ws.file.name}"), ${ws.agents.size} agent(s): ${[...ws.agents.keys()].join(', ') || 'none'}` });
          if (broken.length) checks.push({ name: 'agents', ok: false, detail: broken.join('; ') });
          checks.push({ name: 'network', ok: true, detail: `mode ${ws.config.network.mode}` });
          const creds = loadCredentials(ws.paths.credentialsJson, new Redactor());
          checks.push({ name: 'credentials', ok: true, detail: creds.names().length ? `configured: ${creds.names().join(', ')}` : 'none configured (the mock provider needs none)' });
          const live = await findLiveRuntime(workspacePaths(workspaceDir));
          checks.push({ name: 'runtime', ok: true, detail: live ? `running on 127.0.0.1:${live.port} (pid ${live.pid})` : 'not running; commands will use an ephemeral runtime' });
          checks.push({ name: 'database', ok: true, detail: fs.existsSync(ws.paths.db) ? ws.paths.db : 'not created yet (created on first start)' });
        } catch (e) {
          checks.push({ name: 'workspace', ok: false, detail: (e as Error).message });
        }

        try {
          const mem = new Database(':memory:');
          try { defaultAssertFts5(mem); } finally { mem.close(); }
          checks.push({ name: 'sqlite fts5', ok: true, detail: 'available' });
        } catch (e) {
          checks.push({ name: 'sqlite fts5', ok: false, detail: (e as Error).message });
        }

        const deno = findExecutable('deno', bootstrap.childEnvAllowlist['PATH']);
        checks.push({ name: 'deno', ok: true, detail: deno ? `${deno} (sandboxed code tools arrive in RUN-02)` : 'not on PATH; needed from RUN-02 for the code sandbox' });
        checks.push({ name: 'ui', ok: true, detail: fs.existsSync(`${pkg.uiDist}/index.html`) ? 'built' : 'not built (npm run build:ui); the API and CLI work without it' });

        const failed = checks.filter((c) => !c.ok);
        if (wantsJson(cmd)) outJson({ ok: failed.length === 0, workspace: workspaceDir, checks });
        else for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(12)} ${c.detail}`);
        if (!workspaceOk || failed.length) process.exitCode = 1;
      }),
    );
}
