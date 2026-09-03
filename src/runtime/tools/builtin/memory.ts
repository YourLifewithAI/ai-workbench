// Memory and knowledge, as tools (D-17). `memory.remember` is the only way an agent writes memory — there is no
// automatic end-of-run extraction — and the trust of what it writes is decided by what the run has already
// consumed, not by anything the model says. `memory.search` and `knowledge.search` are private reads: they taint
// the run, which is what makes the exfiltration rule fire on a fetch that follows one.
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';
import type { MemoryScope, MemoryStore, MemoryTrust } from '../../memory/store.js';
import type { ArtifactStore } from '../../artifacts/store.js';

/** Memory is not the filesystem and not the network: these tools need neither. */
const NOTHING = Permissions.parse({});
const READ_ANY_PROJECT = Permissions.parse({ fs: { read: ['projects/'] } });

export interface MemoryToolDeps {
  memory: MemoryStore;
  artifacts: ArtifactStore;
  /** The scopes this agent may read, in retrieval order. The engine decides them; a tool never widens them. */
  scopesFor: (agentId: string, project: string | null) => { scope: MemoryScope; ownerId: string }[];
  /** `untrusted` once the run has consumed external content (artifacts-and-memory.md §Memory). */
  trustFor: (runId: string) => MemoryTrust;
  /** Reading memory or knowledge is reading private content: the run is tainted by it (D-29). */
  markPrivate: (runId: string) => void;
  knowledgeChunks: () => number;
}

export function memoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  const remember: ToolDefinition<
    { content: string; scope?: MemoryScope | undefined; supersedesId?: string | undefined; expiresAt?: string | undefined },
    { id: string; scope: MemoryScope; trust: MemoryTrust }
  > = {
    id: 'memory.remember',
    version: '1.0.0',
    description: 'Remember something across runs. Write what would change how you act next time, not what happened — a preference, a correction, a constraint. One fact per call.',
    input: z.object({
      content: z.string().min(1).max(2000),
      scope: z.enum(['agent', 'user', 'workspace', 'project']).default('agent')
        .describe('agent: only you. project: everyone working in this project. workspace: everyone. user: about the person.'),
      supersedesId: z.string().optional().describe('The id of the item this corrects. That item stops being retrieved.'),
      expiresAt: z.string().optional().describe('ISO date after which this stops being retrieved. Use it for anything seasonal.'),
    }),
    output: z.object({ id: z.string(), scope: z.enum(['agent', 'user', 'workspace', 'project']), trust: z.enum(['trusted', 'untrusted']) }),
    tier: 'write',
    maxPermissions: NOTHING,
    execute: async (input, ctx) => {
      const scope = input.scope ?? 'agent';
      const ownerId = ownerFor(scope, ctx.agentId, ctx.project);
      if (ownerId === null) return toolError('InvalidInput', 'This run has no project, so there is nothing to remember it against. Use a different scope.');
      if (input.supersedesId) {
        const existing = deps.memory.byId(input.supersedesId);
        if (!existing) return toolError('NotFound', `There is no memory item with id "${input.supersedesId}".`);
        if (existing.scope !== scope || existing.ownerId !== ownerId) {
          return toolError('PermissionDenied', 'That item belongs to another scope, so this run cannot correct it.', 'Correct an item you can retrieve.');
        }
      }
      const item = deps.memory.remember({
        scope, ownerId, content: input.content, source: 'agent-tool', trust: deps.trustFor(ctx.runId), runId: ctx.runId,
        ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      });
      return { ok: true, output: { id: item.id, scope: item.scope, trust: item.trust } };
    },
  };

  const search: ToolDefinition<
    { query: string; limit?: number | undefined },
    { items: { id: string; content: string; scope: MemoryScope; trust: MemoryTrust; createdAt: string }[] }
  > = {
    id: 'memory.search',
    version: '1.0.0',
    description: 'Search what you remember. The most relevant items are already in your prompt; use this when you need something older or more specific.',
    input: z.object({ query: z.string().min(1).max(400), limit: z.number().int().min(1).max(20).default(8) }),
    output: z.object({
      items: z.array(z.object({
        id: z.string(), content: z.string(),
        scope: z.enum(['agent', 'user', 'workspace', 'project']), trust: z.enum(['trusted', 'untrusted']), createdAt: z.string(),
      })),
    }),
    tier: 'read',
    maxPermissions: NOTHING,
    execute: async (input, ctx) => {
      deps.markPrivate(ctx.runId);
      const hits = deps.memory.retrieve({
        scopes: deps.scopesFor(ctx.agentId, ctx.project), query: input.query, limit: input.limit ?? 8,
      });
      return {
        ok: true,
        output: { items: hits.map((h) => ({ id: h.id, content: h.content, scope: h.scope, trust: h.trust, createdAt: h.createdAt })) },
      };
    },
  };

  const knowledge: ToolDefinition<
    { query: string; project?: string | undefined; limit?: number | undefined },
    { chunks: { path: string; project: string; offset: number; content: string }[] }
  > = {
    id: 'knowledge.search',
    version: '1.0.0',
    description: 'Search the documents imported into a project. Returns the passages that matched, with the document and where in it they were, so you can cite the place rather than the file.',
    input: z.object({
      query: z.string().min(1).max(400),
      project: z.string().optional().describe('Defaults to this run\'s project. Omit unless you mean another one.'),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    output: z.object({
      chunks: z.array(z.object({ path: z.string(), project: z.string(), offset: z.number().int(), content: z.string() })),
    }),
    tier: 'read',
    maxPermissions: READ_ANY_PROJECT,
    execute: async (input, ctx) => {
      const project = input.project ?? ctx.project ?? undefined;
      deps.markPrivate(ctx.runId);
      const chunks = deps.artifacts.searchChunks(input.query, {
        ...(project ? { projectSlug: project } : {}),
        limit: input.limit ?? deps.knowledgeChunks(),
      });
      return {
        ok: true,
        output: { chunks: chunks.map((c) => ({ path: c.path, project: c.project, offset: c.offset, content: c.content })) },
      };
    },
  };

  return [remember, search, knowledge];
}

/** Who a scope belongs to. `user` is the single owner of this workspace; there is no multi-user story (D-01). */
export function ownerFor(scope: MemoryScope, agentId: string, project: string | null): string | null {
  if (scope === 'agent') return agentId;
  if (scope === 'project') return project;
  if (scope === 'user') return 'owner';
  return 'workspace';
}
