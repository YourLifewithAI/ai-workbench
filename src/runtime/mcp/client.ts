// MCP over stdio (D-31). A server is a subprocess speaking JSON-RPC, one message per line, with the same
// scrubbed environment every other child of this runtime gets: no credentials, no inherited PATH beyond the
// allowlist. Its tools join the same grant matrix as the built-ins — nothing arrives already allowed.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** The version this client speaks. A server that answers with another is used anyway if it lists tools. */
export const PROTOCOL_VERSION = '2025-06-18';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[] | undefined;
  /** Extra environment for this server only. Credentials are refused here as everywhere (D-33). */
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  enabled?: boolean | undefined;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Servers may annotate a tool as read-only. Anything without that annotation is write-tier and needs an
   * approval by default: a tool nobody classified is not a tool anyone should assume is safe.
   */
  readOnly: boolean;
}

export interface McpCallResult { ok: boolean; content: unknown; text: string }

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class McpError extends Error {
  constructor(readonly server: string, message: string) {
    super(message);
    this.name = 'McpError';
  }
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private seq = 0;
  private stderr = '';
  tools: McpToolInfo[] = [];
  serverInfo: { name?: string; version?: string } | null = null;

  constructor(readonly config: McpServerConfig, private readonly env: Record<string, string>, private readonly timeoutMs = 20_000) {}

  get running(): boolean {
    return this.child !== null;
  }

  /** Spawn, handshake, and list. A server that fails any of the three is reported, not retried silently. */
  async start(): Promise<void> {
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: this.env,
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    child.on('exit', () => {
      this.child = null;
      for (const [, p] of this.pending) p.reject(new McpError(this.config.name, `the server exited${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-1)[0]}` : ''}`));
      this.pending.clear();
    });
    child.on('error', (e) => { this.stderr += `\n${e.message}`; });

    const initialized = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ai-workbench', version: '0.0.0' },
    }) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = initialized.serverInfo ?? {};
    this.notify('notifications/initialized', {});

    const listed = await this.request('tools/list', {}) as { tools?: { name?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }[] };
    this.tools = (listed.tools ?? []).map((t): McpToolInfo => ({
      name: String(t.name ?? ''),
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object' },
      readOnly: t.annotations?.readOnlyHint === true,
    })).filter((t) => t.name);
  }

  async call(name: string, args: unknown): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args ?? {} }) as {
      isError?: boolean; content?: { type?: string; text?: string }[];
    };
    const text = (result.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
    return { ok: result.isError !== true, content: result.content ?? [], text };
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref?.();
    });
  }

  /** What `workbench doctor` and the Tools screen show when a server did not come up. */
  get lastError(): string {
    return this.stderr.trim().split('\n').slice(-1)[0] ?? '';
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new McpError(this.config.name, 'the server is not running'));
    const id = ++this.seq;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new McpError(this.config.name, `"${method}" got no answer in ${this.timeoutMs} ms`));
      }, this.timeoutMs).unref?.();
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private onData(text: string): void {
    this.buffer += text;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue; // A server that writes prose on stdout is a server with a bug, not a reason to fall over.
      }
      if (typeof message.id !== 'number') continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new McpError(this.config.name, message.error.message ?? 'the server returned an error'));
      else pending.resolve(message.result ?? {});
    }
  }
}
