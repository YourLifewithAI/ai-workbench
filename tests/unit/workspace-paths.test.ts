import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceRelative } from '../../src/runtime/security/broker.js';

describe('workspaceRelative', () => {
  const ws = path.resolve(path.sep === '\\' ? 'C:\\wb' : '/wb');

  it('reports a path the way a workflow writes one, on every platform', () => {
    const file = path.join(ws, 'projects', 'anthology', 'draft.md');
    expect(workspaceRelative(ws, file)).toBe('projects/anthology/draft.md');
  });

  it('never reports a backslash separator, because a model would not match it to the workflow', () => {
    const file = path.join(ws, 'library', 'notes', 'a.md');
    expect(workspaceRelative(ws, file)).not.toContain('\\');
  });

  it('leaves a file directly in the workspace as its own name', () => {
    expect(workspaceRelative(ws, path.join(ws, 'README.md'))).toBe('README.md');
  });
});
