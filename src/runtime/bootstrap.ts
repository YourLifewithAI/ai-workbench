// The only reader of WORKBENCH_* environment variables (spec/architecture.md §Boundary rules).
// It also snapshots the child-environment allowlist once, so security/childEnv never touches process.env.

export interface Bootstrap {
  workspace: string | undefined;
  port: number | undefined;
  bind: string;
  /** PATH HOME TMPDIR LANG LC_* TZ — the only variables a child process ever inherits. */
  childEnvAllowlist: Record<string, string>;
  /** `$VISUAL`, else `$EDITOR`, for `workbench workflows edit`; undefined means the platform's plain one. */
  editor: string | undefined;
  /** The allowlist plus what an interactive editor needs to draw: the terminal and display variables. */
  editorEnv: Record<string, string>;
}

/** Nothing here carries a secret; an editor without them either cannot draw (vi) or cannot open a window. */
const EDITOR_KEYS = ['TERM', 'COLORTERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'SHELL', 'USER', 'LOGNAME', 'APPDATA'];

const ALLOWLIST_EXACT = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ'];

/**
 * The Windows set, matched without regard to case: Windows spells the search path `Path` as often as `PATH`,
 * and a runtime started from a shell that spells it the first way used to snapshot no PATH at all — so git and
 * Deno were "not on PATH" on a machine that had both. None of these carries anything private (D-33); they are
 * the paths and the shell every process on the machine already knows, which `security/childEnv` also lists.
 */
const WINDOWS_KEYS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];

/** The allowlist, from any environment. Exported so a test can hand it a Windows-shaped one on any platform. */
export function childEnvAllowlistFrom(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const allow: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.startsWith('LC_')) { allow[k] = v; continue; }
    if (platform === 'win32') {
      const upper = k.toUpperCase();
      // One spelling for the one key every lookup reads by name; the rest keep the case Windows gave them.
      if (WINDOWS_KEYS.includes(upper) && !(upper === 'PATH' && 'PATH' in allow)) allow[upper === 'PATH' ? 'PATH' : k] = v;
    } else if (ALLOWLIST_EXACT.includes(k)) {
      allow[k] = v;
    }
  }
  return allow;
}

export function readBootstrap(): Bootstrap {
  const env = process.env;
  const allow = childEnvAllowlistFrom(env);
  const portRaw = env['WORKBENCH_PORT'];
  const port = portRaw !== undefined && portRaw !== '' ? Number(portRaw) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`WORKBENCH_PORT must be an integer between 0 and 65535, got "${portRaw}"`);
  }
  const editorEnv = { ...allow };
  for (const key of EDITOR_KEYS) if (env[key]) editorEnv[key] = env[key]!;
  return {
    workspace: env['WORKBENCH_WORKSPACE'] || undefined,
    port,
    bind: env['WORKBENCH_BIND'] || '127.0.0.1',
    childEnvAllowlist: allow,
    editor: (env['VISUAL'] ?? env['EDITOR'] ?? '').trim() || undefined,
    editorEnv,
  };
}
