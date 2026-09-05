// Findings on the Dashboard (F8): Needs you counts the review's open findings, and the count follows each decision.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DashboardResponse, FindingProposal } from '../../src/shared/api/index.js';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';

let rt: Started;
const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const dashboard = async (): Promise<DashboardResponse> => (await (await fetch(`${rt.baseUrl}/api/v1/dashboard`, { headers: headers() })).json()) as DashboardResponse;
const decide = (id: string, decision: 'apply' | 'dismiss'): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1/permissions/findings/${id}`, { method: 'POST', headers: headers(), body: JSON.stringify({ decision }) });

beforeAll(async () => { rt = await startRuntime(tempWorkspace('dash-findings'), { providerOverride: 'mock' }); });
afterAll(async () => { await rt.stop(); });

const unused = (agentId: string, tool: string): Parameters<Started['runtime']['reviewFindings']['raise']>[0] => {
  const proposal: FindingProposal = { agentId, tool, set: 'unset', label: `Take back ${tool} from ${agentId}` };
  return { key: `unused:${agentId}:${tool}`, kind: 'unused', agentId, tool, headline: `${agentId} holds ${tool} and has never used it.`, evidence: ['Never once.'], note: null, proposal, factsHash: 'facts-1' };
};

describe('GET /dashboard findings', () => {
  it('counts open findings only, and the count follows apply and dismiss', async () => {
    expect((await dashboard()).findings).toBe(0);

    rt.runtime.reviewFindings.raise(unused('researcher', 'http.fetch'), null);
    rt.runtime.reviewFindings.raise(unused('reviewer', 'memory.remember'), null);
    expect((await dashboard()).findings).toBe(2);

    // Raising the same key again refreshes the row rather than counting twice.
    rt.runtime.reviewFindings.raise(unused('researcher', 'http.fetch'), null);
    expect((await dashboard()).findings).toBe(2);

    const [first, second] = rt.runtime.reviewFindings.list('open');
    expect((await decide(first!.id, 'dismiss')).status).toBe(200);
    expect((await dashboard()).findings).toBe(1);
    expect((await decide(second!.id, 'apply')).status).toBe(200);
    expect((await dashboard()).findings).toBe(0);
    expect(rt.runtime.reviewFindings.list('all')).toHaveLength(2);
  });
});
