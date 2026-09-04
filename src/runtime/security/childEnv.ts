// Every child process gets an explicitly constructed environment (D-33). Never process.env.

/**
 * The POSIX set. `HOME` and `TMPDIR` do not exist on Windows, and passing only these there produces a child
 * that cannot resolve a command, cannot find a temp directory, and — without `SystemRoot` — cannot initialise
 * winsock, so it fails in ways that look like the sandbox is broken rather than like the env is empty.
 */
const POSIX_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ'];

/**
 * The Windows equivalents. None of them carries anything private: they are the paths and the shell every
 * process on the machine already knows, which is exactly the bar for this list (D-33).
 */
const WINDOWS_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];

export function childEnv(allowlist: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows environment variable names are case-insensitive, so the comparison has to be too: the same
  // variable arrives as `Path` from one shell and `PATH` from another.
  const wanted = process.platform === 'win32'
    ? new Set(WINDOWS_KEYS.map((k) => k.toLowerCase()))
    : new Set(POSIX_KEYS.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(allowlist)) {
    if (wanted.has(k.toLowerCase()) || k.startsWith('LC_')) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith('WORKBENCH_CRED_')) throw new Error(`refusing to pass credential variable ${k} to a child process`);
    env[k] = v;
  }
  return env;
}
