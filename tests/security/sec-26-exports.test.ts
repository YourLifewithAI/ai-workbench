// SEC-26: an export carries no credential material and says what was redacted out of it.
// SEC-06 is re-run here through a document, which is the new leak surface RUN-03 introduces.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { exportProject, importProject, redactionsIn } from '../../src/runtime/artifacts/transfer.js';
import { openWorkspaceStore } from '../../src/runtime/cli/store.js';
import { startRuntime, tempWorkspace } from '../helpers/workspace.js';

const secret = (): string => `plantedsecret-${randomBytes(12).toString('hex')}`;

describe('SEC-26 exports carry no credential material and name their redactions', () => {
  it('a secret written into a document is redacted in the store, the export, and the import', async () => {
    const ws = tempWorkspace('sec26');
    const SECRET = secret();
    fs.writeFileSync(path.join(ws, 'config', 'credentials.json'), JSON.stringify({ google: { apiKey: SECRET } }), { mode: 0o600 });

    const rt = await startRuntime(ws);
    let documentId: string;
    try {
      // A run whose output happens to contain the credential: exactly what redaction exists for.
      rt.runtime.artifacts.writeDocument({
        projectSlug: 'anthology',
        path: 'notes.md',
        content: `The key we used was ${SECRET} and it should never survive an export.`,
        createdBy: 'run-step',
        runId: 'r1',
        stepId: 'main',
      });
      const doc = rt.runtime.artifacts.findDocumentByPath('anthology', 'notes.md')!;
      documentId = doc.id;
      const stored = rt.runtime.artifacts.getDocument(documentId)!;
      expect(stored.content).not.toContain(SECRET);
      expect(stored.content).toContain('[REDACTED:credential:google]');
    } finally {
      await rt.stop();
    }

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec26-out-'));
    const opened = await openWorkspaceStore(ws);
    try {
      const manifest = exportProject(opened.store, 'anthology', outDir);
      const notes = manifest.documents.find((d) => d.path === 'notes.md')!;
      expect(notes.redactions, 'the manifest names what was removed').toEqual(['credential:google']);

      // Nothing anywhere in the export carries the value.
      for (const file of walk(outDir)) {
        expect(fs.readFileSync(file, 'utf8'), file).not.toContain(SECRET);
      }
      const manifestText = fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8');
      expect(manifestText).not.toContain(SECRET);
      expect(JSON.parse(manifestText)).toMatchObject({ kind: 'project', excluded: expect.arrayContaining(['credentials']) as unknown as string[] });
    } finally {
      await opened.close();
    }

    // And it does not come back on the way in.
    const fresh = tempWorkspace('sec26-import');
    const importer = await openWorkspaceStore(fresh);
    try {
      const result = importProject(importer.store, outDir, 'imported');
      expect(result.documents).toBeGreaterThan(0);
      const imported = importer.store.readDocument('imported', 'notes.md')!;
      expect(imported).not.toContain(SECRET);
      expect(imported).toContain('[REDACTED:credential:google]');
      const versions = importer.store.versions(importer.store.findDocumentByPath('imported', 'notes.md')!.id);
      expect(versions.every((v) => v.createdBy === 'import'), 'this workspace did not produce them').toBe(true);
    } finally {
      await importer.close();
    }
  }, 90_000);

  it('an export refuses to be read by an older workbench, and a duplicate slug is a clear error', async () => {
    const ws = tempWorkspace('sec26-guard');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec26-guard-'));
    const opened = await openWorkspaceStore(ws);
    try {
      exportProject(opened.store, 'anthology', outDir);
      expect(() => importProject(opened.store, outDir), 'the slug is already taken here').toThrow(/already has a project/);

      const manifestFile = path.join(outDir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { schemaVersion: number };
      manifest.schemaVersion = 99;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      expect(() => importProject(opened.store, outDir, 'newer')).toThrow(/newer workbench/);
    } finally {
      await opened.close();
    }
  }, 60_000);

  it('redactionsIn reports every distinct marker, and nothing when there are none', () => {
    expect(redactionsIn('plain text')).toEqual([]);
    expect(redactionsIn('a [REDACTED:credential:google] b [REDACTED:credential:anthropic] c [REDACTED:credential:google]'))
      .toEqual(['credential:anthropic', 'credential:google']);
  });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
