// The Library's store (D-16). Documents live in SQLite with every version and the provenance that produced it;
// files live on disk under the project directory with a row per version. Nothing is overwritten in place.
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { Redactor } from '../security/redaction.js';
import { contentHash } from '../util/canonical.js';
import { WorkspaceError } from '../util/errors.js';
import type { DiffResponse, DocumentDetail, DocumentSummary, DocumentVersionSummary, Project } from '../../shared/api/index.js';
import { diffLines } from './diff.js';

export interface ProjectRow { id: string; slug: string; name: string; description: string | null; created_at: string }
interface DocumentRow { id: string; project_id: string; path: string; type: string; latest_version_id: string | null; created_at: string }
interface VersionRow { id: string; document_id: string; parent_id: string | null; hash: string; content: string; created_by: string; run_id: string | null; step_id: string | null; agent_version: string | null; model_id: string | null; partial: number; created_at: string }

export interface WriteDocumentInput {
  projectSlug: string;
  path: string;
  content: string;
  createdBy: 'run-step' | 'human' | 'import';
  runId?: string | undefined;
  stepId?: string | undefined;
  agentVersion?: string | undefined;
  modelId?: string | undefined;
  type?: string | undefined;
  /** The step ran out of budget and summarised instead of finishing (D-14). */
  partial?: boolean | undefined;
}

/** Documents are chunked for FTS so a hit can name the document, the version, and where in it (artifacts-and-memory.md). */
const CHUNK_CHARS = 1200;

export class ArtifactStore {
  constructor(private readonly db: Db, private readonly projectsDir: string, private readonly redactor: Redactor) {}

  // ---- projects -------------------------------------------------------------------------------

  createProject(slug: string, name: string, description?: string): Project {
    if (this.findProject(slug)) throw new WorkspaceError(path.join(this.projectsDir, slug), `a project with the slug "${slug}" already exists`);
    const row: ProjectRow = { id: ulid(), slug, name, description: description ?? null, created_at: new Date().toISOString() };
    this.db.prepare('INSERT INTO projects (id, slug, name, description, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.slug, row.name, row.description, row.created_at);
    fs.mkdirSync(path.join(this.projectsDir, slug, 'files'), { recursive: true });
    return { ...this.toProject(row), documents: 0 };
  }

  findProject(slug: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined;
  }

  requireProject(slug: string): ProjectRow {
    const row = this.findProject(slug);
    if (!row) throw new WorkspaceError(this.projectsDir, `no project with the slug "${slug}". Create one with: workbench projects create ${slug}`);
    return row;
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[];
    return rows.map((row) => ({
      ...this.toProject(row),
      documents: (this.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE project_id = ?').get(row.id) as { n: number }).n,
    }));
  }

  private toProject(row: ProjectRow): Omit<Project, 'documents'> {
    return { id: row.id, slug: row.slug, name: row.name, description: row.description, createdAt: row.created_at };
  }

  /**
   * Adopts a project directory that exists on disk but has no row — how `init` ships an example project, and how
   * a workspace copied between machines keeps working.
   */
  adoptProjectDirectories(): void {
    if (!fs.existsSync(this.projectsDir)) return;
    for (const entry of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || this.findProject(entry.name)) continue;
      const project = this.createProject(entry.name, entry.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
      const dir = path.join(this.projectsDir, entry.name);
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || !/\.(md|markdown|txt|json)$/i.test(file.name)) continue;
        this.writeDocument({
          projectSlug: project.slug,
          path: file.name,
          content: fs.readFileSync(path.join(dir, file.name), 'utf8'),
          createdBy: 'import',
        });
      }
    }
  }

  // ---- documents ------------------------------------------------------------------------------

  /** Appends a version. An identical body is a no-op, so a re-run that changes nothing does not inflate history. */
  writeDocument(input: WriteDocumentInput): DocumentVersionSummary {
    const project = this.requireProject(input.projectSlug);
    const cleanPath = normalizeDocumentPath(input.path);
    const content = this.redactor.redactString(input.content);
    const now = new Date().toISOString();

    let doc = this.db.prepare('SELECT * FROM documents WHERE project_id = ? AND path = ?').get(project.id, cleanPath) as DocumentRow | undefined;
    if (!doc) {
      doc = { id: ulid(), project_id: project.id, path: cleanPath, type: input.type ?? typeFor(cleanPath), latest_version_id: null, created_at: now };
      this.db.prepare('INSERT INTO documents (id, project_id, path, type, latest_version_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(doc.id, doc.project_id, doc.path, doc.type, doc.created_at);
    }
    const parent = doc.latest_version_id ? (this.db.prepare('SELECT * FROM document_versions WHERE id = ?').get(doc.latest_version_id) as VersionRow) : null;
    const hash = contentHash({ content });
    if (parent && parent.hash === hash) return this.toVersion(parent);

    const version: VersionRow = {
      id: ulid(), document_id: doc.id, parent_id: parent?.id ?? null, hash, content,
      created_by: input.createdBy, run_id: input.runId ?? null, step_id: input.stepId ?? null,
      agent_version: input.agentVersion ?? null, model_id: input.modelId ?? null, partial: input.partial ? 1 : 0, created_at: now,
    };
    const commit = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO document_versions (id, document_id, parent_id, hash, content, created_by, run_id, step_id, agent_version, model_id, partial, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
        .run(version.id, version.document_id, version.parent_id, version.hash, version.content, version.created_by, version.run_id, version.step_id, version.agent_version, version.model_id, version.created_at);
      this.db.prepare('UPDATE documents SET latest_version_id = ? WHERE id = ?').run(version.id, doc!.id);
      this.reindex(doc!.id, version.id, content);
    });
    commit();
    return this.toVersion(version);
  }

  private reindex(documentId: string, versionId: string, content: string): void {
    this.db.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(documentId);
    const insert = this.db.prepare('INSERT INTO documents_fts (content, document_id, version_id, chunk_index, offset) VALUES (?, ?, ?, ?, ?)');
    for (let offset = 0, chunk = 0; offset < content.length || chunk === 0; offset += CHUNK_CHARS, chunk++) {
      insert.run(content.slice(offset, offset + CHUNK_CHARS), documentId, versionId, chunk, offset);
    }
  }

  listDocuments(projectSlug: string): DocumentSummary[] {
    const project = this.requireProject(projectSlug);
    const rows = this.db.prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY path').all(project.id) as DocumentRow[];
    return rows.map((row) => this.toSummary(row, project.slug));
  }

  getDocument(id: string, versionId?: string): DocumentDetail | null {
    const doc = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
    if (!doc) return null;
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(doc.project_id) as ProjectRow;
    const history = this.versions(doc.id);
    const wanted = versionId ?? doc.latest_version_id;
    const version = wanted ? (this.db.prepare('SELECT * FROM document_versions WHERE id = ? AND document_id = ?').get(wanted, doc.id) as VersionRow | undefined) : undefined;
    return {
      ...this.toSummary(doc, project.slug),
      content: version?.content ?? '',
      version: version ? this.toVersion(version) : null,
      history,
    };
  }

  findDocumentByPath(projectSlug: string, docPath: string): DocumentRow | undefined {
    const project = this.requireProject(projectSlug);
    return this.db.prepare('SELECT * FROM documents WHERE project_id = ? AND path = ?').get(project.id, normalizeDocumentPath(docPath)) as DocumentRow | undefined;
  }

  /** The content an agent's `documents: [...]` list injects as its knowledge section. */
  readDocument(projectSlug: string, docPath: string): string | null {
    const doc = this.findDocumentByPath(projectSlug, docPath);
    if (!doc?.latest_version_id) return null;
    const version = this.db.prepare('SELECT content FROM document_versions WHERE id = ?').get(doc.latest_version_id) as { content: string } | undefined;
    return version?.content ?? null;
  }

  versions(documentId: string): DocumentVersionSummary[] {
    const rows = this.db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY created_at, id').all(documentId) as VersionRow[];
    return rows.map((r) => this.toVersion(r));
  }

  diff(documentId: string, fromVersionId: string, toVersionId: string): DiffResponse | null {
    const get = (id: string) => this.db.prepare('SELECT content FROM document_versions WHERE id = ? AND document_id = ?').get(id, documentId) as { content: string } | undefined;
    const from = get(fromVersionId);
    const to = get(toVersionId);
    if (!from || !to) return null;
    return { ...diffLines(from.content, to.content), from: fromVersionId, to: toVersionId };
  }

  private toSummary(row: DocumentRow, slug: string): DocumentSummary {
    const stats = this.db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM document_versions WHERE document_id = ?').get(row.id) as { n: number; latest: string | null };
    return { id: row.id, projectSlug: slug, path: row.path, type: row.type, latestVersionId: row.latest_version_id, versions: stats.n, updatedAt: stats.latest };
  }

  private toVersion(row: VersionRow): DocumentVersionSummary {
    return {
      id: row.id, parentId: row.parent_id, hash: row.hash,
      createdBy: row.created_by as DocumentVersionSummary['createdBy'],
      runId: row.run_id, stepId: row.step_id, agentVersion: row.agent_version, modelId: row.model_id,
      createdAt: row.created_at, bytes: Buffer.byteLength(row.content), partial: row.partial === 1,
    };
  }

  projectDir(slug: string): string {
    return path.join(this.projectsDir, slug);
  }
}

/** Keeps a document path inside its project: no absolute paths, no `..`, forward slashes only (SEC-21 in spirit). */
export function normalizeDocumentPath(input: string): string {
  const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of cleaned.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new WorkspaceError(input, 'a document path may not contain ".."');
    parts.push(part);
  }
  if (!parts.length) throw new WorkspaceError(input, 'a document path may not be empty');
  return parts.join('/');
}

function typeFor(docPath: string): string {
  const ext = path.extname(docPath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.txt') return 'text';
  return 'markdown';
}
