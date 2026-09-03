// `workbench review` and `workbench schedules`: every queue has a screen and a CLI command (ui.md §UX rules).
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { RatingSummary, ReviewItem, ScheduleSummary } from '../../../shared/api/index.js';
import { CliError, connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

interface ListOptions { state?: string; limit?: string }
interface DecideOptions { feedback?: string }
interface RateOptions { step?: string; note?: string }
interface ScheduleAddOptions { cron: string; input?: string[]; project?: string; catchUp?: string; disabled?: boolean }

export function registerReview(program: Command, bootstrap: Bootstrap): void {
  const review = program.command('review').description('outputs waiting for your judgement (nothing is blocked unless a step asks)');

  review
    .command('list')
    .description('list open reviews, blocking gates first')
    .option('--state <state>', 'open (default), unreviewed, pending, continued, rejected, dismissed')
    .action(async (opts: ListOptions, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const { reviews } = await handle.request<{ reviews: ReviewItem[] }>('GET', `/reviews?state=${encodeURIComponent(opts.state ?? 'open')}`);
          if (wantsJson(cmd)) return outJson({ reviews });
          if (!reviews.length) return out('Nothing is waiting. Outputs appear here as runs finish.');
          for (const r of reviews) {
            const mark = r.blocking ? 'BLOCKING' : '        ';
            out(`${mark} ${r.id}  ${r.subject}/${r.stepId}  ${r.modelId ?? '-'}  ${r.ratings.length ? `rated ${r.ratings[r.ratings.length - 1]!.value}/5` : 'unrated'}`);
          }
        } finally {
          await handle.close();
        }
      }),
    );

  review
    .command('show <reviewId>')
    .description('print one review with the output it is about')
    .action(async (reviewId: string, _o: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const { reviews } = await handle.request<{ reviews: ReviewItem[] }>('GET', '/reviews?state=');
          const item = reviews.find((r) => r.id === reviewId);
          if (!item) throw new CliError(`There is no review with id "${reviewId}".`);
          if (wantsJson(cmd)) return outJson(item);
          out(`${item.subject}/${item.stepId}  ${item.state}${item.blocking ? ' (holding the run still)' : ''}`);
          out(`run ${item.runId}${item.documentPath ? ` · ${item.project}/${item.documentPath}` : ''}`);
          if (item.feedback) out(`your last feedback: ${item.feedback}`);
          out('');
          out(item.output ?? '(no output)');
        } finally {
          await handle.close();
        }
      }),
    );

  for (const [name, decision, description, past] of [
    ['continue', 'continue', 'accept this output and let the run carry on', 'accepted; the run carries on'],
    ['reject', 'reject', 're-run the step with your feedback appended (at most twice)', 'rejected; the step re-runs with your feedback'],
    ['dismiss', 'dismiss', 'take it off the queue without judging it', 'dismissed'],
  ] as const) {
    const command = review
      .command(`${name} <reviewId>`)
      .description(description)
      .action(async (reviewId: string, opts: DecideOptions, cmd: Command) =>
        guarded(async () => {
          if (decision === 'reject' && !opts.feedback?.trim()) {
            throw new CliError('--feedback is required to reject: the step re-runs with what you say, so "no" on its own would change nothing.');
          }
          const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap, requireLive: true });
          try {
            const body = { decision, ...(opts.feedback ? { feedback: opts.feedback } : {}) };
            const item = await handle.request<ReviewItem>('POST', `/reviews/${encodeURIComponent(reviewId)}`, body);
            if (wantsJson(cmd)) return outJson(item);
            out(`${reviewId}  ${past}`);
          } finally {
            await handle.close();
          }
        }),
      );
    if (decision !== 'continue') command.option('--feedback <text>', 'what you want instead');
    else command.option('--feedback <text>', 'a note kept with the decision');
  }

  review
    .command('rate <runId>')
    .description('rate an output 1 to 5')
    .argument('<value>', '1 to 5')
    .option('--step <id>', 'which step (default: main)', 'main')
    .option('--note <text>', 'why')
    .action(async (runId: string, value: string, opts: RateOptions, cmd: Command) =>
      guarded(async () => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 5) throw new CliError(`A rating is 1 to 5 (got "${value}").`);
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const rating = await handle.request<RatingSummary>('POST', '/ratings', { runId, stepId: opts.step ?? 'main', value: n, ...(opts.note ? { note: opts.note } : {}) });
          if (wantsJson(cmd)) return outJson(rating);
          out(`rated ${n}/5`);
        } finally {
          await handle.close();
        }
      }),
    );
}

export function registerSchedules(program: Command, bootstrap: Bootstrap): void {
  const schedules = program.command('schedules').description('recurring workflow runs');

  schedules
    .command('list')
    .description('list schedules, soonest first')
    .action(async (_o: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const { schedules: items } = await handle.request<{ schedules: ScheduleSummary[] }>('GET', '/schedules');
          if (wantsJson(cmd)) return outJson({ schedules: items });
          if (!items.length) return out('No schedules. Add one with: workbench schedules add <workflowId> --cron "0 7 * * *"');
          for (const s of items) {
            out(`${s.id}  ${s.workflowId.padEnd(20)} ${s.cron.padEnd(16)} ${s.enabled ? 'enabled ' : 'disabled'} next ${s.nextFireAt ?? '-'}`);
          }
        } finally {
          await handle.close();
        }
      }),
    );

  schedules
    .command('add <workflowId>')
    .description('run a workflow on a cron schedule')
    .requiredOption('--cron <expression>', 'five fields, minute first: "0 7 * * *" is every day at 07:00')
    .option('--input <key=value...>', 'an input for every run; repeatable')
    .option('--project <slug>', 'project to run inside')
    .option('--catch-up <mode>', '"once" fires one run for a window missed while the runtime was down; "none" skips it', 'none')
    .option('--disabled', 'create it, but do not fire it yet')
    .action(async (workflowId: string, opts: ScheduleAddOptions, cmd: Command) =>
      guarded(async () => {
        if (opts.catchUp !== undefined && opts.catchUp !== 'none' && opts.catchUp !== 'once') {
          throw new CliError(`--catch-up accepts "none" or "once" (got "${opts.catchUp}")`);
        }
        const inputs: Record<string, unknown> = {};
        for (const pair of opts.input ?? []) {
          const at = pair.indexOf('=');
          if (at < 1) throw new CliError(`--input expects key=value (got "${pair}")`);
          const key = pair.slice(0, at);
          const raw = pair.slice(at + 1);
          try { inputs[key] = JSON.parse(raw); } catch { inputs[key] = raw; }
        }
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap, requireLive: true });
        try {
          const schedule = await handle.request<ScheduleSummary>('POST', '/schedules', {
            workflowId, cron: opts.cron, inputs,
            ...(opts.project ? { project: opts.project } : {}),
            ...(opts.catchUp ? { catchUp: opts.catchUp } : {}),
            ...(opts.disabled ? { enabled: false } : {}),
          });
          if (wantsJson(cmd)) return outJson(schedule);
          out(`${schedule.id}  ${schedule.workflowId} on "${schedule.cron}", next ${schedule.nextFireAt ?? 'never'}`);
        } finally {
          await handle.close();
        }
      }),
    );

  schedules
    .command('remove <scheduleId>')
    .description('delete a schedule')
    .action(async (scheduleId: string, _o: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap, requireLive: true });
        try {
          await handle.request('DELETE', `/schedules/${encodeURIComponent(scheduleId)}`);
          if (wantsJson(cmd)) return outJson({ scheduleId, deleted: true });
          out(`${scheduleId}  deleted`);
        } finally {
          await handle.close();
        }
      }),
    );
}
