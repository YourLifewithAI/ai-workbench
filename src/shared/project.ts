// A project's space (D-69, RUN-18): `projects/<slug>/project.json`, optional. Its agents, a goals document read
// into every prompt of a run there, a ceiling on the tools any agent may use there, and the memory scopes a run
// there retrieves. Everything here can only narrow: nothing in this file grants (SEC-38).
import { z } from 'zod';

export const MemoryScopeName = z.enum(['agent', 'user', 'workspace', 'project']);
export type MemoryScopeName = z.infer<typeof MemoryScopeName>;

export const ALL_SCOPES: MemoryScopeName[] = ['agent', 'project', 'workspace', 'user'];

export const ProjectSpace = z.strictObject({
  schemaVersion: z.literal(1),
  /** Shown on the Library; the row's name when the file names one. */
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  /** A document path in this project, read into every prompt of a run here as the `goals` section. */
  goals: z.string().min(1).optional(),
  /** The project's agents: first on its run forms, listed on its page. */
  agents: z.array(z.string().min(1)).default([]),
  /** The ceiling: the tools any agent may use in this project. Absent means no ceiling. */
  tools: z.array(z.string().min(1)).optional(),
  /** The memory scopes a run here retrieves, and may write. Default: all four. */
  memory: z.array(MemoryScopeName).min(1).default([...ALL_SCOPES]),
});
export type ProjectSpace = z.infer<typeof ProjectSpace>;

/** A space with no file: a folder, a row, a target — what every project was before D-69. */
export const EMPTY_SPACE: ProjectSpace = { schemaVersion: 1, agents: [], memory: [...ALL_SCOPES] };
