// The mock upstream (D-37): a loopback listener the mock adapter really calls when its catalog entry names a
// `baseUrl`. That one round trip is what exercises the egress checker, the egress log, the declared-endpoint
// path, and the Privacy Inspector end to end — with no cloud provider and no key.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export class MockUpstream {
  private server: http.Server | null = null;
  private portValue = 0;
  readonly received: { method: string; path: string; body: string }[] = [];

  async start(): Promise<number> {
    if (this.server) return this.portValue;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        this.received.push({ method: req.method ?? 'GET', path: req.url ?? '/', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, upstream: 'mock', echoedBytes: Buffer.byteLength(body) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.portValue = (server.address() as AddressInfo).port;
    return this.portValue;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.portValue}/v1`;
  }

  get port(): number {
    return this.portValue;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
