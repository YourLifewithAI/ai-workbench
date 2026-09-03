// The execute tier (D-30, D-55). Nothing here runs in this process. `code.execute` writes the script to the
// run's scratch directory and hands it to Deno with permissions generated from the same effective policy the
// broker uses; `shell` runs one command as a direct child, which is why it always asks a human first.
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';
import type { SandboxLimits } from '../../sandbox/deno.js';

const ANY_WRITE = Permissions.parse({ fs: { read: ['/'], write: ['/'] } });

export interface CodeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  killedBy: 'timeout' | 'output' | 'cancelled' | null;
  durationMs: number;
  /** Which bridged tools the script actually called, in order. The trace shows each call in its own right too. */
  toolCalls: string[];
}

export interface CodeToolDeps {
  available: () => boolean;
  /** Runs the script in the sandbox with the bridge wired up. Implemented by the executor, which owns the broker. */
  runScript: (input: { source: string; runId: string; stepId: string; agentId: string; signal: AbortSignal }) => Promise<CodeRunResult>;
  /** Runs one command as a direct child process. `null` when the platform cannot (there is no fallback). */
  runShell: (input: { command: string; args: string[]; runId: string; stepId: string; signal: AbortSignal }) => Promise<Omit<CodeRunResult, 'toolCalls'>>;
  limits: () => SandboxLimits;
}

export function codeTools(deps: CodeToolDeps): ToolDefinition[] {
  const unavailable = (what: string) => toolError(
    'ToolUnavailable',
    `${what} needs the sandbox, and Deno is not installed.`,
    'Install Deno (https://deno.land) and restart. `workbench doctor` lists what is disabled without it. There is no unsandboxed fallback.',
  );

  const execute: ToolDefinition<
    { source: string },
    { stdout: string; stderr: string; ok: boolean; durationMs: number; toolCalls: string[]; killedBy: string | null }
  > = {
    id: 'code.execute',
    version: '1.0.0',
    description: [
      'Run a JavaScript or TypeScript module in a sandbox with no network and no filesystem beyond what you were granted.',
      'Print your answer with console.log. Your granted tools are available as `await tools["<name>"](input)` — that is the only way out of the sandbox.',
    ].join(' '),
    input: z.object({ source: z.string().min(1).max(100_000).describe('A module. Top-level await works.') }),
    output: z.object({
      stdout: z.string(), stderr: z.string(), ok: z.boolean(), durationMs: z.number().int(),
      toolCalls: z.array(z.string()), killedBy: z.string().nullable(),
    }),
    tier: 'execute',
    maxPermissions: ANY_WRITE,
    execute: async (input, ctx) => {
      if (!deps.available()) return unavailable('Running code');
      const result = await deps.runScript({
        source: input.source, runId: ctx.runId, stepId: ctx.stepId, agentId: ctx.agentId, signal: ctx.signal,
      });
      if (result.killedBy === 'timeout') {
        return toolError('Timeout', `The script was still running after ${deps.limits().wallClockMs} ms and was stopped.`, 'Do less per call, or ask for a smaller piece of the work.');
      }
      if (result.killedBy === 'output') {
        return toolError('InvalidInput', 'The script printed more than the output limit and was stopped.', 'Print a summary rather than everything.');
      }
      // A script that exited non-zero is a result the model can read and fix, not a crash: stderr comes back.
      return {
        ok: true,
        output: {
          stdout: result.stdout, stderr: result.stderr, ok: result.ok, durationMs: result.durationMs,
          toolCalls: result.toolCalls, killedBy: result.killedBy,
        },
      };
    },
  };

  const shell: ToolDefinition<
    { command: string; args?: string[] | undefined },
    { stdout: string; stderr: string; ok: boolean; code: number | null; durationMs: number }
  > = {
    id: 'shell',
    version: '1.0.0',
    description: 'Run one command as a subprocess, in this run\'s scratch directory. Every call asks a human first, because a subprocess\'s network cannot be policed.',
    input: z.object({
      command: z.string().min(1).describe('The program. Not a shell line: no pipes, no redirection, no globbing.'),
      args: z.array(z.string()).default([]),
    }),
    output: z.object({ stdout: z.string(), stderr: z.string(), ok: z.boolean(), code: z.number().int().nullable(), durationMs: z.number().int() }),
    tier: 'execute',
    maxPermissions: ANY_WRITE,
    // The card says why: this is the one tool whose egress the workbench cannot see (tools-and-security.md).
    approvalByDefault: true,
    execute: async (input, ctx) => {
      if (!deps.available()) return unavailable('Running a command');
      const result = await deps.runShell({
        command: input.command, args: input.args ?? [], runId: ctx.runId, stepId: ctx.stepId, signal: ctx.signal,
      });
      if (result.killedBy === 'timeout') {
        return toolError('Timeout', `"${input.command}" was still running after ${deps.limits().wallClockMs} ms and was stopped.`);
      }
      return { ok: true, output: { stdout: result.stdout, stderr: result.stderr, ok: result.ok, code: result.code, durationMs: result.durationMs } };
    },
  };

  return [execute, shell];
}
