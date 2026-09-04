import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import { packagePaths, workspacePaths } from '../../paths.js';
import { loadWorkspace } from '../../workspace/loader.js';
import { loadCredentials } from '../../security/credentials.js';
import { checkSecretFile } from '../../security/secretFile.js';
import { Redactor } from '../../security/redaction.js';
import { defaultAssertFts5 } from '../../db/index.js';
import { findDeno } from '../../sandbox/deno.js';

/** The tools that exist only when the sandbox does, named here so `doctor` can list them without a runtime. */
const EXECUTE_TIER = ['code.execute', 'shell', 'fs.write'];
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
          const credWarnings = creds.warnings();
          // A warning only matters once there is a key to protect; an empty file on Windows is nothing to say.
          const credRisk = credWarnings.length > 0 && creds.names().length > 0;
          checks.push({
            name: 'credentials',
            ok: !credRisk,
            detail: creds.names().length
              ? `configured: ${creds.names().join(', ')}${credRisk ? `. ${credWarnings.join(' ')}` : ''}`
              : 'none configured (the mock provider needs none)',
          });
          // Everything in the workspace that holds a secret, asked the same question: can only you read it?
          // On Windows that is an ACL rather than a mode, and an owner who moved their workspace somewhere
          // shared has no other way to find out.
          const wsPaths = workspacePaths(workspaceDir);
          const secrets: [string, string][] = [
            ['credentials', wsPaths.credentialsJson],
            ['runtime token', wsPaths.runtimeToken],
            ['push keys', path.join(wsPaths.dir, 'data', 'vapid.json')],
          ];
          const exposed = secrets
            .map(([label, file]) => [label, file, checkSecretFile(file)] as const)
            .filter(([, , result]) => !result.protected);
          checks.push({
            name: 'file access',
            ok: exposed.length === 0,
            detail: exposed.length === 0
              ? 'the credentials, runtime token and push keys are readable only by you'
              : exposed.map(([label, , r]) => `${label}: ${r.detail}${r.fix ? `. Run: ${r.fix}` : ''}`).join('; '),
          });

          const live = await findLiveRuntime(wsPaths);
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

        // The sandbox is not a failure when it is missing: a workbench without Deno is a workbench that cannot
        // execute code, which is a smaller thing than a broken one. It says exactly which tools that switches off.
        const deno = findDeno(bootstrap.childEnvAllowlist['PATH']);
        checks.push({
          name: 'deno',
          ok: true,
          detail: deno
            ? `${deno} — the sandbox is available, so ${EXECUTE_TIER.join(', ')} can run`
            : `not on PATH, so these are unavailable: ${EXECUTE_TIER.join(', ')}. Install Deno (https://deno.land) and restart. There is no unsandboxed fallback (D-30).`,
        });
        checks.push({ name: 'ui', ok: true, detail: fs.existsSync(`${pkg.uiDist}/index.html`) ? 'built' : 'not built (npm run build:ui); the API and CLI work without it' });

        const failed = checks.filter((c) => !c.ok);
        if (wantsJson(cmd)) outJson({ ok: failed.length === 0, workspace: workspaceDir, checks });
        else for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(12)} ${c.detail}`);
        if (!workspaceOk || failed.length) process.exitCode = 1;
      }),
    );
}
