// An MCP server's tools, as workbench tools (D-31). They join the same catalogue, the same grant matrix and the
// same approval queue as the built-ins; the only difference a person sees is where the tool came from, which the
// Tools screen says. A tool the server did not annotate as read-only is write-tier and asks a human by default.
import { z } from 'zod';
import { toolError, type ToolDefinition } from '../../shared/tool.js';
import { Permissions } from '../../shared/permissions.js';
import type { JsonSchema } from '../../shared/model.js';
import { validateJson } from '../../shared/jsonschema.js';
import type { McpClient } from './client.js';

/** MCP servers do their own I/O in their own process. The workbench grants them nothing of its own. */
const NOTHING = Permissions.parse({});

/** `mcp.<server>.<tool>`: the server is in the name, so a grant is per server and per tool, never per name alone. */
export const mcpToolId = (server: string, tool: string): string => `mcp.${server}.${tool}`;

export function mcpTools(client: McpClient): ToolDefinition[] {
  return client.tools.map((info): ToolDefinition => ({
    id: mcpToolId(client.config.name, info.name),
    version: client.serverInfo?.version ?? '0.0.0',
    description: info.description || `The "${info.name}" tool from the "${client.config.name}" MCP server.`,
    // The model is shown the server's own schema, unrewritten; the workbench validates against it before calling.
    input: z.record(z.string(), z.unknown()) as unknown as z.ZodType<Record<string, unknown>>,
    inputSchemaOverride: info.inputSchema as JsonSchema,
    output: z.object({ text: z.string(), content: z.unknown() }) as unknown as z.ZodType<{ text: string; content: unknown }>,
    // Not annotated read-only means write, and write from an MCP server asks a human every time.
    tier: info.readOnly ? 'read' : 'write',
    ...(info.readOnly ? {} : { approvalByDefault: true }),
    maxPermissions: NOTHING,
    origin: { kind: 'mcp', server: client.config.name },
    execute: async (input) => {
      const problems = validateJson(input, info.inputSchema as JsonSchema);
      if (problems.length) return toolError('InvalidInput', `That does not match what "${info.name}" accepts: ${problems.join('; ')}`);
      try {
        const result = await client.call(info.name, input);
        if (!result.ok) return toolError('ToolError', result.text || `"${info.name}" failed.`);
        return { ok: true, output: { text: result.text, content: result.content } };
      } catch (e) {
        return toolError('ToolUnavailable', (e as Error).message, `The "${client.config.name}" server is configured in config/workbench.json.`);
      }
    },
  }));
}
