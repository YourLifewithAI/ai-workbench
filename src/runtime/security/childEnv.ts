// Every child process gets an explicitly constructed environment (D-33). Never process.env.
export function childEnv(allowlist: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(allowlist)) {
    if (k === 'PATH' || k === 'HOME' || k === 'TMPDIR' || k === 'LANG' || k === 'TZ' || k.startsWith('LC_')) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith('WORKBENCH_CRED_')) throw new Error(`refusing to pass credential variable ${k} to a child process`);
    env[k] = v;
  }
  return env;
}
