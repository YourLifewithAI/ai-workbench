// A repository's own gate (SEC-35). The command comes from `.workbench/repo.json` — a file a person wrote and
// no tool can edit — and runs on the host, outside the sandbox, because `npm run check` spawns node, a browser
// and Deno and is exactly the line the owner would type (D-66). The agent supplies nothing but the wish to run it.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { runCommand } from '../sandbox/deno.js';
import { PolicyError } from '../security/broker.js';

export const GATE_FILE = path.join('.workbench', 'repo.json');

export const RepoGate = z.strictObject({
  /** One shell line, as the owner would type it in the repository's root. */
  check: z.string().min(1),
  timeoutMs: z.number().int().positive().max(3_600_000).default(900_000),
});
export type RepoGate = z.infer<typeof RepoGate>;

/** Reads the gate, or says by name why there is none. A repository without one has no `check`. */
export function readGate(root: string): RepoGate {
  const file = path.join(root, GATE_FILE);
  if (!fs.existsSync(file)) {
    throw new PolicyError('ToolUnavailable', `This repository declares no check: there is no ${GATE_FILE} in ${root}.`, 'A person adds `{ "check": "<command>" }` there. The agent cannot, and does not get to name the command instead.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new PolicyError('ToolUnavailable', `${GATE_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = RepoGate.safeParse(raw);
  if (!parsed.success) throw new PolicyError('ToolUnavailable', `${GATE_FILE} is not a gate declaration: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

export interface GateRun { ok: boolean; exitCode: number | null; durationMs: number; output: string; killedBy: 'timeout' | 'output' | 'cancelled' | null }

/** 16 MiB of output kept; a gate that prints more than that is stopped. */
const MAX_GATE_OUTPUT = 16 * 1024 * 1024;

export async function runGate(input: { root: string; gate: RepoGate; env: Record<string, string>; signal: AbortSignal }): Promise<GateRun> {
  const result = await runCommand({
    // One stream, in the order it was printed: a transcript where stderr trails stdout puts the failing test
    // after the summary that mentions it. `2>&1` means the same thing to sh and to cmd.exe.
    command: `${input.gate.check} 2>&1`,
    args: [],
    cwd: input.root,
    // What the owner's own CI sets: no colour codes in the transcript, and no tool waiting on a keypress.
    env: { ...input.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
    limits: { wallClockMs: input.gate.timeoutMs, memoryMb: 0, maxOutputBytes: MAX_GATE_OUTPUT },
    signal: input.signal,
    shell: true,
  });
  return { ok: result.ok, exitCode: result.code, durationMs: result.durationMs, output: `${result.stdout}${result.stderr}`, killedBy: result.killedBy };
}
