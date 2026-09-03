// Export and import for agents, workflows, memory and runs (D-34). A bundle is one JSON file a person can read
// before they trust it, and importing one is not the same as authorizing it: **permissions arrive as requested,
// never as granted.** A file someone sent you is a request, and the grant matrix is still the answer.
import { z } from 'zod';
import { Agent } from '../../shared/agent.js';
import { Workflow } from '../../shared/workflow.js';
import type { Redactor } from '../security/redaction.js';

export const BUNDLE_SCHEMA_VERSION = 1;

export const BundleKind = z.enum(['agent', 'workflow', 'memory', 'runs']);
export type BundleKind = z.infer<typeof BundleKind>;

/** What every bundle carries, whatever is inside it: what it is, what version it speaks, and what was taken out. */
export const BundleEnvelope = z.object({
  schemaVersion: z.number().int(),
  kind: BundleKind,
  exportedAt: z.string(),
  /** The names of the secrets the redactor removed on the way out. Empty is a claim, not an absence (SEC-26). */
  redactions: z.array(z.string()).default([]),
  payload: z.unknown(),
});
export type BundleEnvelope = z.infer<typeof BundleEnvelope>;

export class BundleVersionError extends Error {
  constructor(readonly found: number) {
    super(
      `This bundle says schemaVersion ${found}, and this workbench reads ${BUNDLE_SCHEMA_VERSION}. ` +
      (found > BUNDLE_SCHEMA_VERSION
        ? 'It was made by a newer version — upgrade, or ask for an export from an older one.'
        : 'It was made by an older version that this one no longer reads.'),
    );
    this.name = 'BundleVersionError';
  }
}

export class BundleShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleShapeError';
  }
}

/** Wraps anything for export, redacting on the way out and saying what it redacted. */
export function bundle(kind: BundleKind, payload: unknown, redactor: Redactor): BundleEnvelope {
  const before = JSON.stringify(payload);
  const redacted = redactor.redact(payload);
  const after = JSON.stringify(redacted);
  const names = [...new Set([...after.matchAll(/\[REDACTED:([^\]]+)\]/g)].map((m) => m[1]!))].sort();
  // A bundle that says it redacted nothing when it did would be worse than one that redacts nothing at all.
  if (before !== after && !names.length) throw new Error('the redactor changed the payload without leaving a marker');
  return { schemaVersion: BUNDLE_SCHEMA_VERSION, kind, exportedAt: new Date().toISOString(), redactions: names, payload: redacted };
}

/** The other half. A version this workbench does not read is refused by name, never guessed at (D-34). */
export function openBundle(raw: unknown, expected: BundleKind): BundleEnvelope {
  const parsed = BundleEnvelope.safeParse(raw);
  if (!parsed.success) throw new BundleShapeError(`That is not a workbench bundle: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (parsed.data.schemaVersion !== BUNDLE_SCHEMA_VERSION) throw new BundleVersionError(parsed.data.schemaVersion);
  if (parsed.data.kind !== expected) throw new BundleShapeError(`This is a "${parsed.data.kind}" bundle; that route imports a "${expected}".`);
  return parsed.data;
}

/**
 * The trust strip (D-34). An agent arrives with what it *asks for* intact — that is the author telling you what
 * it needs — and with nothing granted, because a downloaded file is not an authorization. The grants live in
 * `config/workbench.json` and are a human's to write, so an import cannot touch them.
 */
export function stripAgentTrust(definition: unknown): { definition: Agent; stripped: string[] } {
  const parsed = Agent.safeParse(definition);
  if (!parsed.success) throw new BundleShapeError(`That agent does not parse: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const stripped: string[] = [];
  const permissions = parsed.data.permissions;
  // What it may ask for stays; what it would be allowed is not a thing a file gets to say.
  if (Object.keys(permissions.tools).length) stripped.push(`${Object.keys(permissions.tools).length} tool request(s), kept as requests`);
  if (permissions.fs.read.length || permissions.fs.write.length) stripped.push('filesystem paths, kept as requests');
  if (permissions.net.allow.length || permissions.net.mode) stripped.push('network policy, kept as a request');
  return { definition: parsed.data, stripped };
}

export function parseWorkflowBundle(payload: unknown): Workflow {
  const parsed = Workflow.safeParse(payload);
  if (!parsed.success) throw new BundleShapeError(`That workflow does not parse: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

export const MemoryBundleItem = z.object({
  scope: z.enum(['agent', 'user', 'workspace', 'project']),
  ownerId: z.string(),
  content: z.string(),
  /** Trust does not survive an export: what another workspace trusted is not what this one knows (D-17). */
  createdAt: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
});
export type MemoryBundleItem = z.infer<typeof MemoryBundleItem>;

export const MemoryBundle = z.object({ items: z.array(MemoryBundleItem) });
