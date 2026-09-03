// `workbench projects`, `documents`, `export project`, `import project` — the CLI half of the Library.
// Export and import act on the workspace directly (like init and doctor); the rest are HTTP clients.
import path from 'node:path';
import type { Command } from 'commander';
import type { Bootstrap } from '../../bootstrap.js';
import type { DocumentDetail, DocumentSummary, Project } from '../../../shared/api/index.js';
import { registerImportKnowledge } from './memory.js';
import { CliError, connect } from '../client.js';
import { guarded, out, outJson, resolveWorkspace, wantsJson } from '../context.js';
import { openWorkspaceStore } from '../store.js';
import { exportProject, importProject } from '../../artifacts/transfer.js';

export function registerLibrary(program: Command, bootstrap: Bootstrap): void {
  const projects = program.command('projects').description('projects group the work of a purpose');

  projects
    .command('list')
    .description('list the projects in this workspace')
    .action(async (_opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const { projects: items } = await handle.request<{ projects: Project[] }>('GET', '/projects');
          if (wantsJson(cmd)) return outJson({ projects: items });
          if (!items.length) return out('No projects yet. Create one with: workbench projects create <slug> --name "<name>"');
          for (const p of items) out(`${p.slug.padEnd(24)} ${String(p.documents).padStart(4)} document(s)  ${p.name}`);
        } finally {
          await handle.close();
        }
      }),
    );

  projects
    .command('create <slug>')
    .description('create a project')
    .option('--name <name>', 'display name (defaults to the slug)')
    .option('--description <text>', 'what this project is for')
    .action(async (slug: string, opts: { name?: string; description?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const project = await handle.request<Project>('POST', '/projects', {
            slug, name: opts.name ?? slug, ...(opts.description ? { description: opts.description } : {}),
          });
          if (wantsJson(cmd)) return outJson(project);
          out(`Created project "${project.slug}".`);
        } finally {
          await handle.close();
        }
      }),
    );

  projects
    .command('show <slug>')
    .description('list a project\'s documents')
    .action(async (slug: string, _opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const { documents } = await handle.request<{ documents: DocumentSummary[] }>('GET', `/projects/${encodeURIComponent(slug)}/documents`);
          if (wantsJson(cmd)) return outJson({ documents });
          if (!documents.length) return out(`"${slug}" has no documents yet.`);
          for (const d of documents) out(`${d.path.padEnd(40)} ${String(d.versions).padStart(3)} version(s)  ${d.updatedAt ?? ''}  ${d.id}`);
        } finally {
          await handle.close();
        }
      }),
    );

  const documents = program.command('documents').description('documents and their versions');

  documents
    .command('show <documentId>')
    .description('print a document (the latest version, or --version <id>)')
    .option('--version <id>', 'a specific version')
    .action(async (id: string, opts: { version?: string }, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const query = opts.version ? `?version=${encodeURIComponent(opts.version)}` : '';
          const doc = await handle.request<DocumentDetail>('GET', `/documents/${encodeURIComponent(id)}${query}`);
          if (wantsJson(cmd)) return outJson(doc);
          out(doc.content);
        } finally {
          await handle.close();
        }
      }),
    );

  documents
    .command('versions <documentId>')
    .description('list a document\'s versions, oldest first')
    .action(async (id: string, _opts: unknown, cmd: Command) =>
      guarded(async () => {
        const handle = await connect({ workspaceDir: resolveWorkspace(cmd, bootstrap), bootstrap });
        try {
          const { versions } = await handle.request<{ versions: DocumentDetail['history'] }>('GET', `/documents/${encodeURIComponent(id)}/versions`);
          if (wantsJson(cmd)) return outJson({ versions });
          for (const [i, v] of versions.entries()) {
            out(`${String(i + 1).padStart(3)}. ${v.id}  ${v.createdBy.padEnd(9)} ${v.createdAt}  ${v.modelId ?? ''} ${v.runId ? `run ${v.runId}` : ''}`);
          }
        } finally {
          await handle.close();
        }
      }),
    );

  const exportCmd = program.command('export').description('export part of this workspace to a folder');
  exportCmd
    .command('project <slug>')
    .description('write a project\'s documents, files and manifest to a folder')
    .requiredOption('--out <dir>', 'destination directory')
    .action(async (slug: string, opts: { out: string }, cmd: Command) =>
      guarded(async () => {
        const { store, close } = await openWorkspaceStore(resolveWorkspace(cmd, bootstrap));
        try {
          const manifest = exportProject(store, slug, path.resolve(opts.out));
          if (wantsJson(cmd)) return outJson(manifest);
          const redacted = manifest.documents.filter((d) => d.redactions.length).length;
          out(`Exported "${slug}": ${manifest.documents.length} document(s), ${manifest.files.length} file(s) → ${path.resolve(opts.out)}`);
          out(redacted ? `${redacted} document(s) contain redacted values; manifest.json names them.` : 'No redactions were needed.');
        } finally {
          await close();
        }
      }),
    );

  const importCmd = program.command('import').description('import into this workspace from a folder');
  // `import knowledge` lives with the memory commands: it is the same run's work and the same screens read it.
  registerImportKnowledge(importCmd, bootstrap);
  importCmd
    .command('project <dir>')
    .description('recreate an exported project here')
    .option('--slug <slug>', 'import under a different slug')
    .action(async (dir: string, opts: { slug?: string }, cmd: Command) =>
      guarded(async () => {
        const { store, close } = await openWorkspaceStore(resolveWorkspace(cmd, bootstrap));
        try {
          const result = importProject(store, path.resolve(dir), opts.slug);
          if (wantsJson(cmd)) return outJson(result);
          out(`Imported "${result.slug}": ${result.documents} document(s), ${result.files} file(s).`);
        } catch (e) {
          throw new CliError((e as Error).message);
        } finally {
          await close();
        }
      }),
    );
}
