// The filesystem, outside the project (D-27). Every path goes through the broker, which canonicalizes with
// `realpath` and applies the hard deny-list, so a grant of `~/notes` cannot become a read of `~/.ssh` through a
// symlink or a `..`. Reads and lists are write-tier because a path outside the project is a bigger thing than a
// document; writing outside the project is execute-tier and needs the sandbox to exist at all (D-30).
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';

/** A ceiling, not a grant: what a human writes in the matrix is what these tools actually get. */
const ANY_READ = Permissions.parse({ fs: { read: ['/'] } });
const ANY_WRITE = Permissions.parse({ fs: { read: ['/'], write: ['/'] } });

export interface FileToolDeps {
  /** Whether the sandbox exists. Writing outside the project is refused by name when it does not (D-30). */
  sandboxAvailable: () => boolean;
  maxBytes: () => number;
}

export function fileTools(deps: FileToolDeps): ToolDefinition[] {
  const read: ToolDefinition<{ path: string }, { path: string; content: string; bytes: number; truncated: boolean }> = {
    id: 'fs.read',
    version: '1.0.0',
    description: 'Read a text file from a path you have been granted. For documents in this run\'s project use artifact.read instead.',
    input: z.object({ path: z.string().min(1).describe('An absolute path, or one relative to the workspace.') }),
    output: z.object({ path: z.string(), content: z.string(), bytes: z.number().int(), truncated: z.boolean() }),
    tier: 'write',
    maxPermissions: ANY_READ,
    execute: async (input, ctx) => {
      try {
        const content = await ctx.fs.read(input.path);
        const limit = deps.maxBytes();
        const truncated = content.length > limit;
        return { ok: true, output: { path: input.path, content: truncated ? content.slice(0, limit) : content, bytes: Buffer.byteLength(content), truncated } };
      } catch (e) {
        return toolError('PermissionDenied', (e as Error).message, (e as { hint?: string }).hint);
      }
    },
  };

  const list: ToolDefinition<{ path: string }, { path: string; entries: { name: string; kind: string; bytes: number }[] }> = {
    id: 'fs.list',
    version: '1.0.0',
    description: 'List a directory you have been granted. Names and kinds only; read a file to see what is in it.',
    input: z.object({ path: z.string().min(1) }),
    output: z.object({
      path: z.string(),
      entries: z.array(z.object({ name: z.string(), kind: z.string(), bytes: z.number().int() })),
    }),
    tier: 'write',
    maxPermissions: ANY_READ,
    execute: async (input, ctx) => {
      try {
        const entries = await ctx.fs.list(input.path);
        return {
          ok: true,
          output: {
            path: input.path,
            entries: entries.map((e) => ({ name: e.path, kind: e.kind, bytes: e.bytes })),
          },
        };
      } catch (e) {
        return toolError('PermissionDenied', (e as Error).message, (e as { hint?: string }).hint);
      }
    },
  };

  const write: ToolDefinition<{ path: string; content: string }, { path: string; bytes: number }> = {
    id: 'fs.write',
    version: '1.0.0',
    description: 'Write a text file to a path you have been granted, outside this run\'s project. Existing files are replaced.',
    input: z.object({ path: z.string().min(1), content: z.string() }),
    output: z.object({ path: z.string(), bytes: z.number().int() }),
    tier: 'execute',
    maxPermissions: ANY_WRITE,
    execute: async (input, ctx) => {
      // The execute tier exists only when the sandbox does. There is no in-process fallback, on purpose: a
      // workbench that quietly writes outside the project without containment is the thing D-30 refuses.
      if (!deps.sandboxAvailable()) {
        return toolError(
          'ToolUnavailable',
          'Writing outside the project needs the sandbox, and Deno is not installed.',
          'Install Deno (https://deno.land) and restart, or write into the project with artifact.write. `workbench doctor` lists what is disabled.',
        );
      }
      try {
        await ctx.fs.write(input.path, input.content);
        return { ok: true, output: { path: input.path, bytes: Buffer.byteLength(input.content) } };
      } catch (e) {
        return toolError('PermissionDenied', (e as Error).message, (e as { hint?: string }).hint);
      }
    },
  };

  return [read, list, write];
}
