// The two lines an agent's card says everywhere it appears: what it has spent, and the loop it runs on.
import type { AgentSummary } from '../../shared/api/index.js';

export const money = (n: number): string => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** "$0.42 today of $5 · $3.10 this month of $40": the agent's runs and every run beneath them, against its own caps. */
export function spentLine(spend: NonNullable<AgentSummary['spend']>): string {
  const cap = (n: number | null): string => (n === null ? '' : ` of $${n}`);
  return `${money(spend.todayUsd)} today${cap(spend.dailyCapUsd)} · ${money(spend.thisMonthUsd)} this month${cap(spend.monthlyCapUsd)}`;
}

/** The loop the agent runs on: when it next fires, or that it is off and where to turn it on. */
export function heartbeatLine(h: NonNullable<AgentSummary['heartbeat']>): string {
  if (!h.enabled) return `${h.workflowName}, off — turn it on under Workflows`;
  const next = h.nextFireAt ? new Date(h.nextFireAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'soon';
  return `${h.workflowName}, next ${next}`;
}
