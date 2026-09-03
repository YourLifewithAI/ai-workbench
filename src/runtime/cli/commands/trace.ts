import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { EventRecord } from '../../../shared/events.js';
import { connect } from '../client.js';
import { guarded, out, resolveWorkspace, wantsJson } from '../context.js';

export function registerTrace(program: Command, bootstrap: Bootstrap): void {
  program
    .command('trace <runId>')
    .description('print a run\'s event trace (JSONL with --json, a readable timeline without)')
    .action(async (runId: string, _opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const jsonl = await handle.requestText(`/runs/${runId}/trace.jsonl`);
          if (wantsJson(cmd)) {
            process.stdout.write(jsonl);
            return;
          }
          for (const line of jsonl.split('\n').filter(Boolean)) {
            const e = JSON.parse(line) as EventRecord;
            out(`${String(e.seq).padStart(4)}  ${e.ts.slice(11, 23)}  ${e.type.padEnd(16)} ${(e.stepId ?? '').padEnd(8)} ${summarize(e)}`);
          }
        } finally {
          await handle.close();
        }
      }),
    );
}

function summarize(e: EventRecord): string {
  const p = e.payload;
  const parts: string[] = [];
  for (const key of ['agentId', 'tool', 'modelId', 'adapter', 'decision', 'reason', 'costUsd', 'latencyMs']) {
    if (p[key] !== undefined && p[key] !== null) parts.push(`${key}=${String(p[key])}`);
  }
  // A denial is the line a human is looking for when they open a trace, so it says so in the summary.
  if (p['allowed'] === false) parts.unshift('DENIED');
  if (e.type === 'tool-completed' && p['ok'] === false) {
    const error = p['error'] as { code?: string } | undefined;
    parts.unshift(error?.code ?? 'failed');
  }
  if (typeof p['output'] === 'string') parts.push(`output=${JSON.stringify(p['output'].slice(0, 60))}${p['output'].length > 60 ? '…' : ''}`);
  if (e.type === 'model-started' && p['request'] && typeof p['request'] === 'object') {
    const req = p['request'] as { messages?: unknown[]; system?: string };
    parts.push(`system=${(req.system ?? '').length} chars, messages=${req.messages?.length ?? 0}`);
  }
  return parts.join(' ');
}
