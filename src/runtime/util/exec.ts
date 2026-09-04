// Locates executables on an explicit PATH string; never consults process.env (D-33).
import fs from 'node:fs';
import path from 'node:path';

export function findExecutable(name: string, pathVar: string | undefined): string | null {
  if (!pathVar) return null;
  // A `.cmd` is deliberately not a candidate. Node refuses to spawn one without `shell: true` since
  // CVE-2024-27980, and everything located here is spawned directly — a shell around a sandbox launcher would
  // put its arguments through cmd.exe parsing, which is the opposite of what this module exists for. Returning
  // a shim we cannot execute would only move the failure to the spawn, as EINVAL with no explanation.
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.com`] : [name];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = path.join(dir, n);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0)) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * Whether PATH advertises `name` through a shim this process cannot execute — on Windows, a `.cmd` or `.bat`.
 * Separate from `findExecutable` on purpose: "PATH offers this tool but not in a form we can spawn" is a
 * different fact from "PATH does not offer it", and only the first justifies looking somewhere else.
 */
export function hasUnspawnableShim(name: string, pathVar: string | undefined): boolean {
  if (process.platform !== 'win32' || !pathVar) return false;
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const n of [`${name}.cmd`, `${name}.bat`, name]) {
      try {
        if (fs.statSync(path.join(dir, n)).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}
