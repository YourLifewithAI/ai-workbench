// `workbench approvals`: the security queue has a CLI too (ui.md §UX rules). Nothing here is modal-only.
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { ApprovalItem, ToolsResponse } from '../../../shared/api/index.js';
import { CliError, connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

interface DecideOptions { remember?: boolean; action?: string }
interface GrantOptions { deny?: boolean; unset?: boolean }

export function registerApprovals(program: Command, bootstrap: Bootstrap): void {
  const approvals = program.command('approvals').description('actions waiting for your permission');

  approvals
    .command('list')
    .description('list pending approvals, newest first')
    .option('--state <state>', 'pending (default), allowed, denied, expired, all')
    .action(async (opts: { state?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const { approvals: items } = await handle.request<{ approvals: ApprovalItem[] }>('GET', `/approvals?state=${encodeURIComponent(opts.state ?? 'pending')}`);
          if (wantsJson(cmd)) return outJson({ approvals: items });
          if (!items.length) return out('Nothing is waiting for permission.');
          for (const item of items) {
            out(`${item.batchId}  ${item.subject}/${item.stepId}  expires ${new Date(item.expiresAt).toLocaleString()}`);
            for (const action of item.actions) {
              out(`    ${action.tool}  ${JSON.stringify(action.args).slice(0, 100)}`);
              out(`      why: ${action.policy}`);
              if (action.remember) out(`      remember would write: ${JSON.stringify(action.remember)}`);
            }
          }
        } finally {
          await handle.close();
        }
      }),
    );

  for (const [name, decision] of [['allow', 'allow'], ['deny', 'deny']] as const) {
    approvals
      .command(`${name} <batchOrId>`)
      .description(name === 'allow' ? 'let it happen' : 'refuse it; the agent is told and carries on')
      .option('--remember', 'also write the narrowest rule for next time (allow only)')
      .option('--action <id>', 'decide one action rather than the whole batch')
      .action(async (batchOrId: string, opts: DecideOptions, cmd: Command) =>
        guarded(async () => {
          if (opts.remember && decision === 'deny') throw new CliError('--remember applies to allow, not deny. A refusal is not a rule.');
          const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap, requireLive: true });
          try {
            await handle.request('POST', `/approvals/${encodeURIComponent(batchOrId)}`, {
              decision: decision === 'allow' && opts.remember ? 'allow-remember' : decision,
              ...(opts.action ? { actionId: opts.action } : {}),
            });
            if (wantsJson(cmd)) return outJson({ batchOrId, decision });
            out(`${batchOrId}  ${decision === 'allow' ? 'allowed' : 'denied'}`);
          } finally {
            await handle.close();
          }
        }),
      );
  }
}

export function registerTools(program: Command, bootstrap: Bootstrap): void {
  const tools = program.command('tools').description('what tools exist and who may use them');

  tools
    .command('list')
    .description('the tool catalogue with its tiers')
    .action(async (_o: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const body = await handle.request<ToolsResponse>('GET', '/tools');
          if (wantsJson(cmd)) return outJson(body);
          for (const tool of body.tools) {
            out(`${tool.id.padEnd(20)} ${tool.tier.padEnd(8)} ${tool.approvalByDefault ? 'always asks  ' : '             '} ${tool.description}`);
          }
        } finally {
          await handle.close();
        }
      }),
    );

  tools
    .command('grants')
    .description('who may use what, and why')
    .option('--agent <id>', 'one agent only')
    .action(async (opts: { agent?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const body = await handle.request<ToolsResponse>('GET', '/tools');
          const cells = opts.agent ? body.matrix.filter((m) => m.agentId === opts.agent) : body.matrix;
          if (wantsJson(cmd)) return outJson({ matrix: cells, remembered: body.remembered });
          for (const cell of cells) {
            const mark = cell.effective ? 'allowed' : 'denied ';
            out(`${mark} ${cell.agentId.padEnd(14)} ${cell.toolId.padEnd(20)} ${cell.requested ? 'asked for it' : '            '}  ${cell.reason}`);
          }
          if (body.remembered.length) {
            out('');
            out('remembered approvals:');
            for (const rule of body.remembered) out(`  ${JSON.stringify(rule)}`);
          }
        } finally {
          await handle.close();
        }
      }),
    );

  tools
    .command('grant <agentId> <toolId>')
    .description('let an agent use a tool (or --deny, or --unset)')
    .option('--deny', 'refuse it explicitly, which beats any other layer')
    .option('--unset', 'remove the entry; the tool falls back to denied-by-default')
    .action(async (agentId: string, toolId: string, opts: GrantOptions, cmd: Command) =>
      guarded(async () => {
        if (opts.deny && opts.unset) throw new CliError('--deny and --unset are different things; pick one.');
        const grant = opts.deny ? 'deny' : opts.unset ? 'unset' : 'allow';
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap, requireLive: true });
        try {
          const cell = await handle.request('PUT', '/tools/grants', { agentId, toolId, grant });
          if (wantsJson(cmd)) return outJson(cell);
          out(`${agentId} · ${toolId}: ${grant}`);
        } finally {
          await handle.close();
        }
      }),
    );
}
