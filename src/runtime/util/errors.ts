import type { ZodError } from 'zod';

/** A validation error that names the file and JSON path (spec/architecture.md §Workspace contract). */
export class WorkspaceError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'WorkspaceError';
  }
}

export function formatZodError(file: string, error: ZodError): WorkspaceError {
  const lines = error.issues.map((i) => `  at ${i.path.length ? '$.' + i.path.map(String).join('.') : '$'}: ${i.message}`);
  return new WorkspaceError(file, `invalid\n${lines.join('\n')}`);
}
