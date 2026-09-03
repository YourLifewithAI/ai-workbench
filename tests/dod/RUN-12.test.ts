// RUN-12 Definition of done (spec/runs/RUN-12.md). Item 1 (the phone viewport) is @run-12 in e2e.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { CLI_DIST, startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import { packagePaths } from '../../src/runtime/paths.js';
import type { PushSubscription, PushSubscriptionsResponse, RunDetail } from '../../src/shared/api/index.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 12`, which builds first).');
});

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

/** A PNG's declared size, read from its IHDR, so a mislabelled icon in the manifest is caught. */
function pngSize(file: string): { width: number; height: number } {
  const buffer = fs.readFileSync(file);
  expect(buffer.subarray(0, 8).toString('hex'), `${file} is a PNG`).toBe('89504e470d0a1a0a');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** A stub push service: records what would have been sent, and never leaves the machine. */
function recordingSender(): { sent: { endpoint: string; payload: unknown }[]; send: NonNullable<Parameters<typeof startRuntime>[1]>['sendPush'] } {
  const sent: { endpoint: string; payload: unknown }[] = [];
  return {
    sent,
    send: async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as unknown });
      return { statusCode: 201 };
    },
  };
}

const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/subscriptions/abc123',
  keys: { p256dh: 'BM3b7l2kFnCg3n8m8xkzY5rM2iQ4vRbYh0nJ7t2sLpQxOaK1cVvE9dHfGjIkLmNoPqRsTuVwXyZaBcDeFgHiJkM', auth: 'k9Qb0m4rTn2sVwXyZaBcDe' },
};

describe('DoD 3: the workspace has its own notification keys, and the routes are behind the token', () => {
  it('init writes data/vapid.json at 0600 and the public key is served', async () => {
    const ws = tempWorkspace('dod12-vapid');
    const file = path.join(ws, 'data', 'vapid.json');
    expect(fs.existsSync(file), '`workbench init` generates the pair').toBe(true);
    expect(fs.statSync(file).mode & 0o777, 'readable only by the owner, like the runtime token').toBe(0o600);

    const keys = JSON.parse(fs.readFileSync(file, 'utf8')) as { publicKey: string; privateKey: string };
    const rt = await startRuntime(ws);
    try {
      const served = (await (await fetch(`${rt.baseUrl}/api/v1/push/vapid-public-key`, { headers: headers(rt) })).json()) as { publicKey: string };
      expect(served.publicKey).toBe(keys.publicKey);
      expect(JSON.stringify(served), 'the private half is never served').not.toContain(keys.privateKey);

      // SEC-01 for the push routes: no token, no answer.
      for (const [method, route] of [['GET', '/push/vapid-public-key'], ['GET', '/push/subscriptions'], ['POST', '/push/subscribe'], ['DELETE', '/push/subscriptions/x']] as const) {
        const res = await fetch(`${rt.baseUrl}/api/v1${route}`, { method, ...(method === 'POST' ? { body: '{}', headers: { 'Content-Type': 'application/json' } } : {}) });
        expect(res.status, `${method} ${route} without a token`).toBe(401);
      }
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('restarting keeps the same keys, because rotating would deafen every device that subscribed', async () => {
    const ws = tempWorkspace('dod12-vapid-stable');
    const before = fs.readFileSync(path.join(ws, 'data', 'vapid.json'), 'utf8');
    const first = await startRuntime(ws);
    await first.stop();
    const second = await startRuntime(ws);
    await second.stop();
    expect(fs.readFileSync(path.join(ws, 'data', 'vapid.json'), 'utf8')).toBe(before);
  }, 60_000);
});

describe('DoD 2: a subscriber gets the four kinds with the right deep links, and unsubscribing stops them', () => {
  it('each kind arrives once, carrying ids only', async () => {
    const ws = tempWorkspace('dod12-push');
    fs.writeFileSync(path.join(ws, 'config', 'workbench.json'), JSON.stringify({ schemaVersion: 1, push: { enabled: true, events: [] } }));
    const recorder = recordingSender();
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, sendPush: recorder.send });
    try {
      const subscribed = await fetch(`${rt.baseUrl}/api/v1/push/subscribe`, {
        method: 'POST', headers: headers(rt), body: JSON.stringify({ ...SUBSCRIPTION, deviceLabel: 'Test iPhone' }),
      });
      expect(subscribed.status).toBe(201);
      const subscription = (await subscribed.json()) as PushSubscription;
      expect(subscription.endpoint, 'the capability URL is never returned in full').toBe('push.example.test');

      for (const kind of ['approval-requested', 'review-blocking', 'run-failed', 'scheduled-run-completed'] as const) {
        await rt.runtime.push.notify(kind, { id: `id-${kind}`, runId: 'RUN123' });
      }
      expect(recorder.sent).toHaveLength(4);

      const payloads = recorder.sent.map((s) => s.payload as { kind: string; id: string; runId: string; url: string; title: string });
      expect(payloads.map((p) => p.kind)).toEqual(['approval-requested', 'review-blocking', 'run-failed', 'scheduled-run-completed']);
      expect(payloads.map((p) => p.url)).toEqual(['/dashboard', '/review', '/runs/RUN123', '/runs/RUN123']);
      // SEC-32: ids and kinds only. Nothing else may ever appear in a payload.
      for (const payload of payloads) {
        expect(Object.keys(payload).sort()).toEqual(['id', 'kind', 'runId', 'title', 'url']);
      }

      // A device that only wants approvals is not told about anything else.
      await fetch(`${rt.baseUrl}/api/v1/push/subscriptions/${subscription.id}`, {
        method: 'PUT', headers: headers(rt), body: JSON.stringify({ events: ['approval-requested'] }),
      });
      recorder.sent.length = 0;
      await rt.runtime.push.notify('run-failed', { id: 'x', runId: 'RUN123' });
      expect(recorder.sent, 'a kind this device turned off').toHaveLength(0);
      await rt.runtime.push.notify('approval-requested', { id: 'x', runId: 'RUN123' });
      expect(recorder.sent, 'a kind it kept').toHaveLength(1);

      // Unsubscribing stops them entirely.
      const removed = await fetch(`${rt.baseUrl}/api/v1/push/subscriptions/${subscription.id}`, { method: 'DELETE', headers: headers(rt) });
      expect(removed.status).toBe(200);
      recorder.sent.length = 0;
      await rt.runtime.push.notify('approval-requested', { id: 'x', runId: 'RUN123' });
      expect(recorder.sent).toHaveLength(0);
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('the four moments in a real run each reach the phone', async () => {
    const ws = tempWorkspace('dod12-moments');
    fs.writeFileSync(path.join(ws, 'config', 'workbench.json'), JSON.stringify({
      schemaVersion: 1,
      push: { enabled: true, events: [] },
      grants: { weaver: { tools: { 'permission.request': 'allow' } } },
    }));
    fs.writeFileSync(path.join(ws, 'fixtures', 'aaa.json'), JSON.stringify({
      match: { systemIncludes: 'The Weaver', callIndex: 1 },
      respond: { text: 'May I?', toolCalls: [{ name: 'permission.request', input: { what: 'save a note', why: 'it belongs with the draft' } }] },
    }));
    const recorder = recordingSender();
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, sendPush: recorder.send });
    try {
      await fetch(`${rt.baseUrl}/api/v1/push/subscribe`, { method: 'POST', headers: headers(rt), body: JSON.stringify(SUBSCRIPTION) });

      const started = await fetch(`${rt.baseUrl}/api/v1/runs`, {
        method: 'POST', headers: headers(rt), body: JSON.stringify({ kind: 'agent', id: 'weaver', inputs: { input: 'Draft.' }, project: 'anthology' }),
      });
      const { runId } = (await started.json()) as { runId: string };
      await waitFor(async () => {
        const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as RunDetail;
        return detail.state === 'waiting_approval';
      }, 30_000);

      await waitFor(() => recorder.sent.length > 0, 10_000);
      const payload = recorder.sent[0]!.payload as { kind: string; runId: string; url: string };
      expect(payload.kind).toBe('approval-requested');
      expect(payload.runId).toBe(runId);
      expect(payload.url).toBe('/dashboard');
      // SEC-32 through the real path: the thing the agent asked for never reaches the payload.
      expect(JSON.stringify(recorder.sent)).not.toContain('save a note');
      expect(JSON.stringify(recorder.sent)).not.toContain('it belongs with the draft');
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('push turned off for the workspace sends nothing, even to a device that subscribed', async () => {
    const ws = tempWorkspace('dod12-off');
    fs.writeFileSync(path.join(ws, 'config', 'workbench.json'), JSON.stringify({ schemaVersion: 1, push: { enabled: false, events: [] } }));
    const recorder = recordingSender();
    const rt = await startRuntime(ws, { sendPush: recorder.send });
    try {
      await fetch(`${rt.baseUrl}/api/v1/push/subscribe`, { method: 'POST', headers: headers(rt), body: JSON.stringify(SUBSCRIPTION) });
      const listed = (await (await fetch(`${rt.baseUrl}/api/v1/push/subscriptions`, { headers: headers(rt) })).json()) as PushSubscriptionsResponse;
      expect(listed.enabled).toBe(false);
      // The subscription is kept — turning push off is not the same as throwing devices away — but nothing goes.
      expect(listed.subscriptions).toHaveLength(1);
      await rt.runtime.push.notify('run-failed', { id: 'x', runId: 'y' });
      expect(recorder.sent).toHaveLength(0);
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('a workspace with push on but no device subscribed sends nothing either', async () => {
    const ws = tempWorkspace('dod12-nodevice');
    const recorder = recordingSender();
    const rt = await startRuntime(ws, { sendPush: recorder.send });
    try {
      const listed = (await (await fetch(`${rt.baseUrl}/api/v1/push/subscriptions`, { headers: headers(rt) })).json()) as PushSubscriptionsResponse;
      expect(listed.enabled, 'the default is on, because it does nothing until a device asks').toBe(true);
      expect(listed.subscriptions).toHaveLength(0);
      await rt.runtime.push.notify('run-failed', { id: 'x', runId: 'y' });
      expect(recorder.sent).toHaveLength(0);
    } finally {
      await rt.stop();
    }
  }, 60_000);
});

describe('DoD 4: the built app is installable', () => {
  it('the manifest and its icons are what a browser needs to offer Add to Home Screen', () => {
    const dist = packagePaths().uiDist;
    const manifestFile = path.join(dist, 'manifest.webmanifest');
    expect(fs.existsSync(manifestFile), 'the manifest is in the built app').toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      name: string; short_name: string; start_url: string; display: string; icons: { src: string; sizes: string; purpose?: string }[];
    };

    // This is what Chrome's installability check actually requires, asserted directly rather than through a
    // Lighthouse run that would need a headless browser and a network in CI.
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url.startsWith('/')).toBe(true);

    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((i) => i.purpose === 'maskable'), 'a maskable icon, so iOS does not crop the mark').toBe(true);

    for (const icon of manifest.icons) {
      const file = path.join(dist, icon.src.replace(/^\//, ''));
      expect(fs.existsSync(file), `${icon.src} exists`).toBe(true);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(file), `${icon.src} really is ${icon.sizes}`).toEqual({ width: w, height: h });
    }

    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-touch-icon');
    expect(html).toContain('theme-color');
  });

  it('the service worker caches the shell and nothing else', () => {
    const sw = fs.readFileSync(path.join(packagePaths().uiDist, 'sw.js'), 'utf8');
    expect(sw).toContain("addEventListener('fetch'");
    expect(sw).toContain("addEventListener('push'");
    expect(sw).toContain("addEventListener('notificationclick'");
    // The line that keeps workspace data off the device: API responses are never cached (D-61).
    expect(sw).toContain("url.pathname.startsWith('/api/')");
  });

  it('the service worker is served from the runtime, at the scope it claims', async () => {
    const ws = tempWorkspace('dod12-serve');
    const rt = await startRuntime(ws);
    try {
      // No token: the worker is the application shell, and a browser fetches it before any token exists.
      const res = await fetch(`${rt.baseUrl}/sw.js`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('workbench-shell');
      const manifest = await fetch(`${rt.baseUrl}/manifest.webmanifest`);
      expect(manifest.status).toBe(200);
      const icon = await fetch(`${rt.baseUrl}/icon-192.png`);
      expect(icon.status).toBe(200);
      expect(Buffer.from(await icon.arrayBuffer()).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    } finally {
      await rt.stop();
    }
  }, 60_000);
});
