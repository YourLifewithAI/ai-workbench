// The Library, as tools. `artifact.read` also reads the run's own scratch directory as `scratch/…` without a
// grant, which is what makes a truncated or masked tool result recoverable (D-47, tools-and-security.md §Tools).
import path from 'node:path';
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';
import type { ArtifactStore } from '../../artifacts/store.js';

const READ_ANY_PROJECT = Permissions.parse({ fs: { read: ['projects/'] } });
const WRITE_ANY_PROJECT = Permissions.parse({ fs: { read: ['projects/'], write: ['projects/'] } });

export interface ArtifactToolDeps {
  artifacts: ArtifactStore;
  /** The workspace root, so `scratch/…` resolves under the run's own directory. */
  workspaceDir: string;
}

export function artifactTools(deps: ArtifactToolDeps): ToolDefinition[] {
  const read: ToolDefinition<{ path: string; project?: string | undefined }, { path: string; content: string; bytes: number }> = {
    id: 'artifact.read',
    version: '1.0.0',
    description: 'Read a document from this run\'s project, or a file from this run\'s scratch directory ("scratch/<name>"). Scratch is where truncated tool results are kept whole.',
    input: z.object({
      path: z.string().min(1).describe('A document path such as "beats.md", or "scratch/<id>.txt".'),
      project: z.string().optional().describe('Another project in this workspace. Defaults to this run\'s.'),
    }),
    output: z.object({ path: z.string(), content: z.string(), bytes: z.number().int() }),
    tier: 'read',
    maxPermissions: READ_ANY_PROJECT,
    execute: async (input, ctx) => {
      // Scratch first: it belongs to this run and needs no grant, so a masked result is always recoverable.
      if (input.path.startsWith('scratch/')) {
        try {
          const content = await ctx.fs.read(path.join(ctx.scratchDir, input.path.slice('scratch/'.length)));
          return { ok: true, output: { path: input.path, content, bytes: Buffer.byteLength(content) } };
        } catch (e) {
          return toolError('NotFound', `There is nothing at "${input.path}" in this run's scratch.`, (e as Error).message);
        }
      }
      const project = input.project ?? ctx.project;
      if (!project) return toolError('InvalidInput', 'This run has no project, so there is nothing to read from. Name one with `project`.');
      // A document lives in the database, not on disk, so the broker is asked for the decision alone — on the
      // path the document *would* have, which is what a grant is written against.
      const decision = ctx.fs.can(path.join(deps.workspaceDir, 'projects', project, input.path), 'read');
      if (!decision.allowed) return toolError('PermissionDenied', decision.reason, decision.hint);
      const content = deps.artifacts.readDocument(project, input.path);
      if (content === null) return toolError('NotFound', `There is no document at "${input.path}" in the "${project}" project.`);
      return { ok: true, output: { path: input.path, content, bytes: Buffer.byteLength(content) } };
    },
  };

  const list: ToolDefinition<{ project?: string | undefined }, { documents: { path: string; versions: number; updatedAt: string | null }[] }> = {
    id: 'artifact.list',
    version: '1.0.0',
    description: 'List the documents in this run\'s project, with how many versions each has.',
    input: z.object({ project: z.string().optional() }),
    output: z.object({ documents: z.array(z.object({ path: z.string(), versions: z.number().int(), updatedAt: z.string().nullable() })) }),
    tier: 'read',
    maxPermissions: READ_ANY_PROJECT,
    execute: async (input, ctx) => {
      const project = input.project ?? ctx.project;
      if (!project) return toolError('InvalidInput', 'This run has no project. Name one with `project`.');
      const decision = ctx.fs.can(path.join(deps.workspaceDir, 'projects', project), 'read');
      if (!decision.allowed) return toolError('PermissionDenied', decision.reason, decision.hint);
      try {
        const documents = deps.artifacts.listDocuments(project).map((d) => ({ path: d.path, versions: d.versions, updatedAt: d.updatedAt }));
        return { ok: true, output: { documents } };
      } catch (e) {
        return toolError('NotFound', (e as Error).message);
      }
    },
  };

  const write: ToolDefinition<{ path: string; content: string }, { path: string; versionId: string; project: string }> = {
    id: 'artifact.write',
    version: '1.0.0',
    description: 'File a document in this run\'s project. This creates a new version; nothing is ever overwritten.',
    input: z.object({
      path: z.string().min(1).describe('A path inside the project, such as "notes/margins.md".'),
      content: z.string().max(1_000_000),
    }),
    output: z.object({ path: z.string(), versionId: z.string(), project: z.string() }),
    tier: 'write',
    maxPermissions: WRITE_ANY_PROJECT,
    execute: async (input, ctx) => {
      if (!ctx.project) return toolError('InvalidInput', 'This run has no project, so there is nowhere to file this. Start the run with a project.');
      // The broker decides first, on the path the document would have; the version then goes to the store,
      // which is where documents actually live. One write, not two.
      const decision = ctx.fs.can(path.join(deps.workspaceDir, 'projects', ctx.project, input.path), 'write');
      if (!decision.allowed) return toolError('PermissionDenied', decision.reason, decision.hint);
      const version = deps.artifacts.writeDocument({
        projectSlug: ctx.project, path: input.path, content: input.content, createdBy: 'run-step',
        runId: ctx.runId, stepId: ctx.stepId,
      });
      return { ok: true, output: { path: input.path, versionId: version.id, project: ctx.project } };
    },
  };

  return [read as ToolDefinition, list as ToolDefinition, write as ToolDefinition];
}
