// Every configured MCP server, started once at boot and stopped with the runtime. A server that fails to start
// is a message on the Tools screen and in `workbench doctor`, not a crash: one broken server should not take a
// workbench down, and a person needs to be told which one it was.
import { z } from 'zod';
import type { Logger } from '../log/index.js';
import { childEnv } from '../security/childEnv.js';
import type { ToolDefinition } from '../../shared/tool.js';
import { McpClient, type McpServerConfig } from './client.js';
import { mcpTools } from './tools.js';

export const McpServerFile = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type McpServerFile = z.infer<typeof McpServerFile>;

export interface McpServerStatus {
  name: string;
  running: boolean;
  tools: string[];
  error: string | null;
  serverInfo: { name?: string; version?: string } | null;
}

export class McpHost {
  private readonly clients = new Map<string, McpClient>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly deps: {
      servers: () => unknown[];
      childEnvAllowlist: Record<string, string>;
      log: Logger;
    },
  ) {}

  /** Starts every enabled server. Returns the tools they published, ready for the catalogue. */
  async start(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];
    for (const raw of this.deps.servers()) {
      const parsed = McpServerFile.safeParse(raw);
      if (!parsed.success) {
        const name = (raw as { name?: string })?.name ?? 'unnamed';
        this.errors.set(name, `its configuration is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        this.deps.log.warn({ server: name }, 'an MCP server is configured wrongly and was not started');
        continue;
      }
      const config: McpServerConfig = parsed.data;
      if (config.enabled === false) continue;
      // The server's own environment on top of the allowlist — and `childEnv` refuses a credential variable.
      const client = new McpClient(config, childEnv(this.deps.childEnvAllowlist, config.env ?? {}));
      try {
        await client.start();
        this.clients.set(config.name, client);
        tools.push(...mcpTools(client));
        this.deps.log.info({ server: config.name, tools: client.tools.length }, 'MCP server started');
      } catch (e) {
        this.errors.set(config.name, (e as Error).message || client.lastError);
        this.deps.log.warn({ server: config.name, err: e }, 'an MCP server did not start');
        await client.stop();
      }
    }
    return tools;
  }

  status(): McpServerStatus[] {
    const names = new Set([...this.clients.keys(), ...this.errors.keys()]);
    return [...names].sort().map((name) => {
      const client = this.clients.get(name);
      return {
        name,
        running: client?.running ?? false,
        tools: client ? client.tools.map((t) => t.name) : [],
        error: this.errors.get(name) ?? null,
        serverInfo: client?.serverInfo ?? null,
      };
    });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
  }
}
