// Project export and import (D-35). An export is a folder a human can read: the documents at their latest
// version, the files, and a manifest that says where each version came from and what was redacted out of it.
import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactStore } from './store.js';
import { WorkspaceError } from '../util/errors.js';

export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportedVersion {
  id: string;
  hash: string;
  createdBy: string;
  createdAt: string;
  runId: string | null;
  stepId: string | null;
  agentVersion: string | null;
  modelId: string | null;
}

export interface ExportedDocument {
  path: string;
  type: string;
  hash: string;
  bytes: number;
  versions: ExportedVersion[];
  /** Names of the secrets the redactor removed from this document's stored content, if any. */
  redactions: string[];
}

export interface ExportManifest {
  schemaVersion: number;
  kind: 'project';
  project: { slug: string; name: string; description: string | null; createdAt: string };
  exportedAt: string;
  documents: ExportedDocument[];
  files: { path: string; bytes: number }[];
  /** Stated plainly so nobody has to infer it from an absence. */
  excluded: string[];
}

const REDACTION_MARKER = /\[REDACTED:([^\]]+)\]/g;

export function redactionsIn(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(REDACTION_MARKER)) names.add(match[1]!);
  return [...names].sort();
}

export function exportProject(store: ArtifactStore, slug: string, outDir: string): ExportManifest {
  const project = store.requireProject(slug);
  const documents = store.listDocuments(slug);
  fs.mkdirSync(path.join(outDir, 'documents'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'files'), { recursive: true });

  const exported: ExportedDocument[] = [];
  for (const summary of documents) {
    const detail = store.getDocument(summary.id);
    if (!detail?.version) continue;
    const target = path.join(outDir, 'documents', summary.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, detail.content);
    exported.push({
      path: summary.path,
      type: summary.type,
      hash: detail.version.hash,
      bytes: Buffer.byteLength(detail.content),
      versions: detail.history.map((v) => ({
        id: v.id, hash: v.hash, createdBy: v.createdBy, createdAt: v.createdAt,
        runId: v.runId, stepId: v.stepId, agentVersion: v.agentVersion, modelId: v.modelId,
      })),
      redactions: redactionsIn(detail.content),
    });
  }

  const files: { path: string; bytes: number }[] = [];
  const filesDir = path.join(store.projectDir(slug), 'files');
  if (fs.existsSync(filesDir)) {
    for (const relative of walk(filesDir)) {
      const source = path.join(filesDir, relative);
      const target = path.join(outDir, 'files', relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      files.push({ path: relative, bytes: fs.statSync(source).size });
    }
  }

  const manifest: ExportManifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    kind: 'project',
    project: { slug: project.slug, name: project.name, description: project.description, createdAt: project.created_at },
    exportedAt: new Date().toISOString(),
    documents: exported,
    files,
    excluded: ['credentials', 'the runtime token', 'runtime.json', 'event traces'],
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export interface ImportResult { slug: string; documents: number; files: number }

/** Imported versions are `import`, never the provenance they had elsewhere: this workspace did not produce them. */
export function importProject(store: ArtifactStore, inDir: string, slugOverride?: string): ImportResult {
  const manifestFile = path.join(inDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new WorkspaceError(manifestFile, 'not found: an exported project has a manifest.json at its root');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as ExportManifest;
  if (manifest.schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new WorkspaceError(manifestFile, `was written by a newer workbench (schemaVersion ${manifest.schemaVersion}; this one reads ${EXPORT_SCHEMA_VERSION})`);
  }
  if (manifest.kind !== 'project') throw new WorkspaceError(manifestFile, `is a "${manifest.kind}" export, not a project`);

  const slug = slugOverride ?? manifest.project.slug;
  if (store.findProject(slug)) throw new WorkspaceError(inDir, `this workspace already has a project called "${slug}". Import it under another slug with --slug.`);
  store.createProject(slug, manifest.project.name, manifest.project.description ?? undefined);

  let documents = 0;
  for (const doc of manifest.documents) {
    const source = path.join(inDir, 'documents', doc.path);
    if (!fs.existsSync(source)) continue;
    store.writeDocument({ projectSlug: slug, path: doc.path, content: fs.readFileSync(source, 'utf8'), createdBy: 'import', type: doc.type });
    documents += 1;
  }

  let files = 0;
  const filesIn = path.join(inDir, 'files');
  if (fs.existsSync(filesIn)) {
    for (const relative of walk(filesIn)) {
      const target = path.join(store.projectDir(slug), 'files', relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(filesIn, relative), target);
      files += 1;
    }
  }
  return { slug, documents, files };
}

/**
 * Relative paths, always with forward slashes. An export is meant to be readable somewhere else — the manifest
 * is the part a human reads and another workbench imports — and `path.join` on Windows would write
 * `site\\style.css` into it. Importing that on Linux does not make a directory; it makes one file whose name
 * contains a backslash. Windows accepts forward slashes for reading, so joining them back is unaffected.
 */
function walk(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), relative) : [relative];
  });
}
