// Project spaces on disk (D-69): `projects/<slug>/project.json`, loaded like workflows (a file that does not
// parse is listed as broken, never thrown), saved hash-pinned like a workflow (D-62): the save is refused when
// the file changed since the form loaded it.
import fs from 'node:fs';
import path from 'node:path';
import { ProjectSpace } from '../../shared/project.js';
import { contentHash } from '../util/canonical.js';
import { formatZodError } from '../util/errors.js';

export interface LoadedSpace { slug: string; definition: ProjectSpace; version: string; file: string }
export interface BrokenSpace { slug: string; file: string; message: string }

export type SpaceWriteCode = 'validation' | 'conflict' | 'not_found';
export class SpaceWriteError extends Error {
  constructor(readonly code: SpaceWriteCode, message: string, readonly currentVersion?: string) {
    super(message);
    this.name = 'SpaceWriteError';
  }
}

export function spaceFile(projectsDir: string, slug: string): string {
  return path.join(projectsDir, slug, 'project.json');
}

/** The hash of the parsed form, defaults applied, so leaving a default out changes nothing the runtime sees. */
export function versionOf(definition: ProjectSpace): string {
  return contentHash(definition);
}

export function loadSpaces(projectsDir: string): { spaces: Map<string, LoadedSpace>; broken: BrokenSpace[] } {
  const spaces = new Map<string, LoadedSpace>();
  const broken: BrokenSpace[] = [];
  if (!fs.existsSync(projectsDir)) return { spaces, broken };
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = spaceFile(projectsDir, entry.name);
    if (!fs.existsSync(file)) continue;
    const state = diskState(file);
    if (!state.exists) continue;
    if (state.definition) spaces.set(entry.name, { slug: entry.name, definition: state.definition, version: state.version, file });
    else broken.push({ slug: entry.name, file, message: state.message ?? 'does not parse' });
  }
  return { spaces, broken };
}

/** What the file holds right now, or why it cannot be used. A file that no longer parses has still changed. */
export function diskState(file: string): { exists: false } | { exists: true; version: string; definition: ProjectSpace | null; message?: string } {
  if (!fs.existsSync(file)) return { exists: false };
  const raw = fs.readFileSync(file, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { exists: true, version: `unparseable:${contentHash(raw)}`, definition: null, message: `${file}: not JSON (${(e as Error).message})` };
  }
  const parsed = ProjectSpace.safeParse(json);
  if (!parsed.success) return { exists: true, version: `invalid:${contentHash(raw)}`, definition: null, message: formatZodError(file, parsed.error).message };
  return { exists: true, version: versionOf(parsed.data), definition: parsed.data };
}

/** The version a form should pin when there is no file yet. */
export const NO_FILE = 'none';

export function saveSpace(input: { projectsDir: string; slug: string; raw: unknown; baseVersion: string }): LoadedSpace {
  const dir = path.join(input.projectsDir, input.slug);
  if (!fs.existsSync(dir)) throw new SpaceWriteError('not_found', `There is no project directory for "${input.slug}".`);
  const parsed = ProjectSpace.safeParse(input.raw);
  if (!parsed.success) throw new SpaceWriteError('validation', formatZodError('project.json', parsed.error).message);
  const file = spaceFile(input.projectsDir, input.slug);
  const disk = diskState(file);
  const current = disk.exists ? disk.version : NO_FILE;
  if (current !== input.baseVersion) {
    throw new SpaceWriteError('conflict', `project.json for "${input.slug}" changed since this form loaded it (it is now ${current}). Reload the page and try again.`, current);
  }
  fs.writeFileSync(file, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8');
  return { slug: input.slug, definition: parsed.data, version: versionOf(parsed.data), file };
}
