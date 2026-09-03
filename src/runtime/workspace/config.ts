// Config precedence (D-20): defaults < config/workbench.json. Later wins; objects deep-merge; arrays replace.
import fs from 'node:fs';
import { WorkbenchConfig, WorkbenchConfigInput } from '../../shared/workspace.js';
import { WorkspaceError, formatZodError } from '../util/errors.js';

export function deepMerge<T>(base: T, override: unknown): T {
  if (Array.isArray(override)) return override as T;
  if (override && typeof override === 'object' && base && typeof base === 'object' && !Array.isArray(base)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out as T;
  }
  return override === undefined ? base : (override as T);
}

export function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new WorkspaceError(file, `cannot read: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new WorkspaceError(file, `not valid JSON: ${(e as Error).message}`);
  }
}

export function loadConfig(defaultsFile: string, workspaceFile: string): WorkbenchConfig {
  const defaults = readJsonFile(defaultsFile);
  const raw = readJsonFile(workspaceFile);
  const input = WorkbenchConfigInput.safeParse(raw);
  if (!input.success) throw formatZodError(workspaceFile, input.error);
  const merged = deepMerge(defaults, input.data);
  const parsed = WorkbenchConfig.safeParse(merged);
  if (!parsed.success) throw formatZodError(workspaceFile, parsed.error);
  return parsed.data;
}
