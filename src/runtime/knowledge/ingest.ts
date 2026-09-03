// Knowledge ingestion (artifacts-and-memory.md §Knowledge). Knowledge is documents: a PDF, a CSV and a web page
// all become project documents, which the Library already chunks into `documents_fts`. There is no separate
// knowledge store, and no embeddings (D-18 is a later decision, and it would need its own model id per row).
import { z } from 'zod';
import { extractText, getDocumentProxy } from 'unpdf';
import { extractArticle } from '../tools/builtin/web.js';
import type { ArtifactStore } from '../artifacts/store.js';
import type { DocumentVersionSummary } from '../../shared/api/index.js';

export const KnowledgeFormat = z.enum(['markdown', 'text', 'json', 'csv', 'html', 'pdf']);
export type KnowledgeFormat = z.infer<typeof KnowledgeFormat>;

const BY_EXTENSION: Record<string, KnowledgeFormat> = {
  md: 'markdown', markdown: 'markdown',
  txt: 'text', text: 'text', log: 'text',
  json: 'json',
  csv: 'csv', tsv: 'csv',
  html: 'html', htm: 'html',
  pdf: 'pdf',
};

/** The formats the brief names, and nothing else: an unknown extension is refused rather than guessed at. */
export function formatFor(filename: string): KnowledgeFormat | null {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return null;
  return BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ?? null;
}

export class UnsupportedKnowledgeFormat extends Error {
  constructor(readonly filename: string) {
    super(`Cannot read "${filename}": knowledge can be markdown, text, JSON, CSV, HTML or PDF.`);
    this.name = 'UnsupportedKnowledgeFormat';
  }
}

/** Bytes to the text that will be indexed. Nothing here is lossy on purpose except the HTML chrome. */
export async function parseKnowledge(filename: string, bytes: Uint8Array): Promise<{ format: KnowledgeFormat; title: string | null; text: string }> {
  const format = formatFor(filename);
  if (!format) throw new UnsupportedKnowledgeFormat(filename);

  if (format === 'pdf') {
    // A PDF's text is its pages joined; a page break is a paragraph break, not a lost line.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return { format, title: null, text: (Array.isArray(text) ? text.join('\n\n') : text).trim() };
  }

  const raw = new TextDecoder('utf-8').decode(bytes);
  if (format === 'html') {
    const article = extractArticle(raw, `file:///${filename}`);
    return { format, title: article.title, text: article.text };
  }
  if (format === 'json') {
    // Pretty-printed, so a search hit lands on a line a human can read rather than in the middle of one line.
    try {
      return { format, title: null, text: JSON.stringify(JSON.parse(raw), null, 2) };
    } catch {
      return { format, title: null, text: raw };
    }
  }
  if (format === 'csv') return { format, title: null, text: csvToText(raw, filename.toLowerCase().endsWith('.tsv') ? '\t' : ',') };
  return { format, title: null, text: raw };
}

/**
 * A row per line, `column: value` per field, because that is what full-text search can actually match. A bare
 * CSV indexes as a wall of commas and every query hits every row.
 */
export function csvToText(raw: string, delimiter = ','): string {
  const rows = parseDelimited(raw, delimiter);
  if (!rows.length) return '';
  const [header, ...body] = rows;
  if (!body.length) return (header ?? []).join(delimiter);
  return body
    .map((row) => row.map((cell, i) => `${header![i] ?? `column ${i + 1}`}: ${cell}`).join(' · '))
    .join('\n');
}

/** RFC 4180 enough: quoted fields, doubled quotes inside them, CRLF or LF. */
function parseDelimited(raw: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) {
      if (c === '"' && raw[i + 1] === '"') { field += '"'; i++; continue; }
      if (c === '"') { quoted = false; continue; }
      field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(field.trim()); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && raw[i + 1] === '\n') i++;
      row.push(field.trim());
      if (row.some((f) => f.length)) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  row.push(field.trim());
  if (row.some((f) => f.length)) rows.push(row);
  return rows;
}

export interface IngestInput {
  projectSlug: string;
  filename: string;
  bytes: Uint8Array;
  /** Where it lands in the project. Defaults to `knowledge/<filename>.md`. */
  path?: string | undefined;
}

/** One ingested file: a document version with `createdBy: 'import'`, already chunked for `knowledge.search`. */
export async function ingestKnowledge(store: ArtifactStore, input: IngestInput): Promise<{ path: string; format: KnowledgeFormat; characters: number; version: DocumentVersionSummary }> {
  const parsed = await parseKnowledge(input.filename, input.bytes);
  const path = input.path ?? `knowledge/${baseName(input.filename)}.md`;
  const header = parsed.title ? `# ${parsed.title}\n\n` : '';
  const version = store.writeDocument({ projectSlug: input.projectSlug, path, content: header + parsed.text, createdBy: 'import' });
  return { path, format: parsed.format, characters: parsed.text.length, version };
}

function baseName(filename: string): string {
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const name = slash === -1 ? filename : filename.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}
