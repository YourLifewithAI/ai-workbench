// agent.json (spec/agents-and-prompts.md). Declarative; no code; no vendor names in instructions.
import { z } from 'zod';
import { Permissions, Budgets } from './permissions.js';
import { JsonSchema, ModelCapabilities } from './model.js';

export const Scope = z.enum(['agent', 'user', 'workspace', 'project']);
export type Scope = z.infer<typeof Scope>;

export const InstructionSection = z.object({ name: z.string().min(1), text: z.string() });
export type InstructionSection = z.infer<typeof InstructionSection>;

/** A partial of ModelCapabilities whose numeric fields are minimums. */
export const ModelRequirements = ModelCapabilities.partial().omit({ text: true });
export type ModelRequirements = z.infer<typeof ModelRequirements>;

export const Agent = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string(),
  instructions: z.union([z.array(InstructionSection).min(1), z.object({ file: z.literal('instructions.md') })]),
  modelPolicy: z.object({
    primary: z.string(),
    fallbacks: z.array(z.string()).default([]),
    requires: ModelRequirements.optional(),
  }),
  tools: z.array(z.object({ id: z.string(), version: z.string().optional() })).default([]),
  permissions: Permissions.prefault({}),
  memory: z.object({ read: z.array(Scope), write: z.array(Scope) }).default({ read: [], write: [] }),
  output: z.object({
    kind: z.enum(['text', 'json', 'document']),
    schema: JsonSchema.optional(),
    document: z.string().optional(),
  }).default({ kind: 'text' }),
  documents: z.array(z.string()).default([]),
  budgets: Budgets.partial().optional(),
  review: z.enum(['none', 'blocking']).default('none'),
});
export type Agent = z.infer<typeof Agent>;

/** An agent after loading: instructions resolved to sections, version hash computed. */
export interface LoadedAgent {
  definition: Agent;
  sections: InstructionSection[];
  version: string; // sha256:<hex> of canonical JSON (definition + instructions.md when used)
  dir: string;
}
