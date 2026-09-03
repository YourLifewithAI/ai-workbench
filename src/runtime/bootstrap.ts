// The only reader of WORKBENCH_* environment variables (spec/architecture.md §Boundary rules).
// It also snapshots the child-environment allowlist once, so security/childEnv never touches process.env.

export interface Bootstrap {
  workspace: string | undefined;
  port: number | undefined;
  bind: string;
  /** PATH HOME TMPDIR LANG LC_* TZ — the only variables a child process ever inherits. */
  childEnvAllowlist: Record<string, string>;
}

const ALLOWLIST_EXACT = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ'];

export function readBootstrap(): Bootstrap {
  const env = process.env;
  const allow: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (ALLOWLIST_EXACT.includes(k) || k.startsWith('LC_')) allow[k] = v;
  }
  const portRaw = env['WORKBENCH_PORT'];
  const port = portRaw !== undefined && portRaw !== '' ? Number(portRaw) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`WORKBENCH_PORT must be an integer between 0 and 65535, got "${portRaw}"`);
  }
  return {
    workspace: env['WORKBENCH_WORKSPACE'] || undefined,
    port,
    bind: env['WORKBENCH_BIND'] || '127.0.0.1',
    childEnvAllowlist: allow,
  };
}
