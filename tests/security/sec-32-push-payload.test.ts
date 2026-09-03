// SEC-32: a push payload carries ids and kinds only. A notification travels through Apple's or Google's servers
// and lands on a lock screen, so it must be a pointer — never the thing it points at.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import type { RunDetail } from '../../src/shared/api/index.js';

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/subscriptions/sec32',
  keys: { p256dh: 'BM3b7l2kFnCg3n8m8xkzY5rM2iQ4vRbYh0nJ7t2sLpQxOaK1cVvE9dHfGjIkLmNoPqRsTuVwXyZaBcDeFgHiJkM', auth: 'k9Qb0m4rTn2sVwXyZaBcDe' },
};

describe('SEC-32 a push payload is a pointer, never the content', () => {
  it('a planted document title, output, and credential never appear in any notification', async () => {
    const ws = tempWorkspace('sec32');
    // Three things that must never leave: a document path, the text an agent produced, and a credential.
    const secretTitle = `margin-note-${randomBytes(6).toString('hex')}`;
    const secretProse = `the drill was ${randomBytes(6).toString('hex')} years old`;
    const secretKey = `plantedsecret-${randomBytes(12).toString('hex')}`;
    fs.writeFileSync(path.join(ws, 'config', 'credentials.json'), JSON.stringify({ google: { apiKey: secretKey } }), { mode: 0o600 });
    fs.writeFileSync(path.join(ws, 'config', 'workbench.json'), JSON.stringify({
      schemaVersion: 1,
      push: { enabled: true, events: [] },
      budgets: { maxModelCalls: 2 },
      grants: { weaver: { tools: { 'permission.request': 'allow' } } },
    }));
    fs.writeFileSync(path.join(ws, 'fixtures', 'aaa.json'), JSON.stringify({
      match: { systemIncludes: 'The Weaver', callIndex: 1 },
      respond: { text: secretProse, toolCalls: [{ name: 'permission.request', input: { what: `write ${secretTitle}.md`, why: secretProse } }] },
    }));

    const sent: string[] = [];
    const rt = await startRuntime(ws, {
      providerOverride: 'mock',
      noScheduler: true,
      sendPush: async (_subscription, payload) => { sent.push(payload); return { statusCode: 201 }; },
    });
    try {
      await fetch(`${rt.baseUrl}/api/v1/push/subscribe`, { method: 'POST', headers: headers(rt), body: JSON.stringify(SUBSCRIPTION) });

      const started = await fetch(`${rt.baseUrl}/api/v1/runs`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ kind: 'agent', id: 'weaver', inputs: { input: `Draft, and remember ${secretKey}.` }, project: 'anthology' }),
      });
      const { runId } = (await started.json()) as { runId: string };
      await waitFor(async () => {
        const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as RunDetail;
        return detail.state === 'waiting_approval';
      }, 30_000);
      await waitFor(() => sent.length > 0, 10_000);

      // Deny it, so the run also fails and a second kind of notification goes out.
      const pending = ((await (await fetch(`${rt.baseUrl}/api/v1/approvals`, { headers: headers(rt) })).json()) as { approvals: { batchId: string }[] }).approvals;
      await fetch(`${rt.baseUrl}/api/v1/approvals/${pending[0]!.batchId}`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'deny' }) });
      await waitFor(async () => {
        const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as RunDetail;
        return detail.state !== 'waiting_approval' && detail.state !== 'running';
      }, 30_000);

      expect(sent.length).toBeGreaterThan(0);
      const everything = sent.join('\n');
      expect(everything, 'a document path').not.toContain(secretTitle);
      expect(everything, 'what the agent wrote').not.toContain(secretProse);
      expect(everything, 'a credential').not.toContain(secretKey);

      // And what a payload *does* carry is exactly five keys, every time.
      for (const payload of sent) {
        expect(Object.keys(JSON.parse(payload) as Record<string, unknown>).sort()).toEqual(['id', 'kind', 'runId', 'title', 'url']);
      }
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('the service worker shows a fixed title and body, not anything from the payload', () => {
    const sw = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'public', 'sw.js'), 'utf8');
    // The body is a constant. Only the title comes from the payload, and the runtime writes that from a fixed
    // table of four strings — a compromised push service still cannot put words on a lock screen.
    expect(sw).toContain("body: 'Open the workbench to see it.'");
    expect(sw).not.toContain('data.body');
    expect(sw).not.toContain('data.output');
  });
});
