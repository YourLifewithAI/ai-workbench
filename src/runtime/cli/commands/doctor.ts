import fs from 'node:fs';
import { resolveRoles, rolesReferenced } from '../../models/roles.js';
import { statusFor } from '../../models/availability.js';
import { findModel } from '../../models/catalog.js';
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
import { priceFor } from '../../models/catalog.js';
import { grantFor } from '../../security/permissions.js';
import { GATE_FILE, readGate } from '../../repos/gate.js';
import { findExecutable } from '../../util/exec.js';

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

          // A cloud model with no price would cost $0, and no cap can stop a run that costs nothing (D-65).
          const unpriced = ws.catalog.models.filter((m) => m.locality === 'cloud' && m.adapter !== 'mock' && !priceFor(m, new Date()));
          checks.push({
            name: 'pricing',
            ok: unpriced.length === 0,
            detail: unpriced.length
              ? `no price on record for ${unpriced.map((m) => m.id).join(', ')} — unusable until one is entered in config/models.json (D-65)`
              : 'every cloud model has a price on record',
          });

          // Which models do the work (D-68): every role an agent names comes to something, or doctor says which does not.
          const rolesInUse = rolesReferenced([...ws.agents.values()].map((a) => a.definition.modelPolicy), []);
          const readyHere = (id: string): boolean => {
            const entry = findModel(ws.catalog, id);
            if (!entry) return false;
            // No runtime here to poll a local endpoint or list adapters: a local model is given the benefit of the doubt.
            const status = statusFor(entry, {
              catalog: ws.catalog, mode: ws.config.network.mode, hasAdapter: () => true,
              hasCredential: (provider) => creds.names().includes(provider),
              reachableEndpoints: new Set(ws.catalog.models.filter((m) => m.locality === 'local' && m.baseUrl).map((m) => m.baseUrl!)),
            });
            return status.availability === 'ready';
          };
          const resolved = resolveRoles(ws.config.models.roles, readyHere);
          const undefinedRoles = rolesInUse.filter((r) => !(r in ws.config.models.roles));
          // A used role with nothing ready is a fault once there is a key to run on; with no key at all it is
          // just the state of things, and the mock provider needs no role to resolve.
          const empty = Object.entries(resolved).filter(([name, id]) => id === null && rolesInUse.includes(name)).map(([name]) => name);
          const fault = undefinedRoles.length > 0 || (empty.length > 0 && creds.names().length > 0);
          checks.push({
            name: 'model roles',
            ok: !fault,
            detail: [
              ...Object.entries(resolved).map(([name, id]) => `${name} → ${id ?? 'nothing ready'}`),
              ...(undefinedRoles.length ? [`named by an agent but not defined: ${undefinedRoles.join(', ')}`] : []),
              ...(empty.length ? [creds.names().length ? 'set the order in Settings → Which models do the work, or add a key for a model in the list' : 'no key is configured, so nothing is ready; the mock provider needs none'] : []),
            ].join('; '),
          });

          // Every repository a person has granted (D-66): is it there, is it a checkout, does it declare a gate.
          const repositories: string[] = [];
          let repoProblems = 0;
          for (const agentId of Object.keys(ws.config.grants).sort()) {
            for (const repo of grantFor(ws.config, agentId)?.repos ?? []) {
              const problems: string[] = [];
              if (!path.isAbsolute(repo.path)) problems.push('not an absolute path, so it grants nothing');
              else if (!fs.existsSync(repo.path)) problems.push('does not exist');
              else if (!fs.existsSync(path.join(repo.path, '.git'))) problems.push('is not a git checkout');
              let gate = 'no gate';
              if (!problems.length) {
                try {
                  gate = `gate: ${readGate(repo.path).check}`;
                } catch (e) {
                  gate = fs.existsSync(path.join(repo.path, GATE_FILE)) ? `${GATE_FILE} is broken: ${(e as Error).message}` : `no ${GATE_FILE}, so no check`;
                }
              }
              repoProblems += problems.length;
              repositories.push(`${agentId} → ${repo.path} (may push to ${repo.branches}; ${problems.length ? problems.join(', ') : gate})`);
            }
          }
          const git = findExecutable('git', bootstrap.childEnvAllowlist['PATH']);
          checks.push({
            name: 'repositories',
            ok: repoProblems === 0 && (repositories.length === 0 || git !== null),
            detail: repositories.length
              ? `${git ? '' : 'git is not on PATH, so the git tools refuse by name. '}${repositories.join('; ')}`
              : 'none granted (grants.<agent>.repos in config/workbench.json)',
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
