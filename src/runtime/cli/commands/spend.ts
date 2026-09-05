// `workbench spend`: where the money went (F3). The same numbers the Dashboard shows and the caps read.
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { SpendResponse } from '../../../shared/api/index.js';
import { money } from '../../../shared/summary.js';
import { connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';

export function registerSpend(program: Command, bootstrap: Bootstrap): void {
  program
    .command('spend')
    .description('today, this week, this month against its cap, and the last thirty days by model and by what was run')
    .action(async (_o: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const s = await handle.request<SpendResponse>('GET', '/spend');
          if (wantsJson(cmd)) return outJson(s);
          out(`today        ${money(s.todayUsd)}${s.dailySpendCapUsd > 0 ? ` of ${money(s.dailySpendCapUsd)}` : ''}`);
          out(`last 7 days  ${money(s.last7DaysUsd)}`);
          out(`last 30 days ${money(s.last30DaysUsd)}`);
          out(`this month   ${money(s.thisMonthUsd)}${s.monthlySpendCapUsd > 0 ? ` of ${money(s.monthlySpendCapUsd)}` : ' (no monthly cap)'} · heading for ${money(s.projectedMonthUsd)} with ${s.daysLeftInMonth} day${s.daysLeftInMonth === 1 ? '' : 's'} left`);
          if (s.schedulesPaused) out('schedules are paused: the month\'s cap is used up. Raise monthlySpendCapUsd in Settings, or wait for the month to turn.');
          if (s.byModel.length) {
            out('\nby model, last 30 days');
            for (const m of s.byModel) out(`  ${money(m.usd).padStart(9)}  ${String(m.calls).padStart(5)} call${m.calls === 1 ? ' ' : 's'}  ${m.modelId}`);
          }
          if (s.bySubject.length) {
            out('\nby what was run, last 30 days');
            for (const r of s.bySubject) out(`  ${money(r.usd).padStart(9)}  ${String(r.runs).padStart(5)} run${r.runs === 1 ? ' ' : 's'}   ${r.subject} (${r.kind})`);
          }
          if (!s.byModel.length) out('\nNo model calls in the last thirty days.');
        } finally {
          await handle.close();
        }
      }),
    );
}
