// Locates executables on an explicit PATH string; never consults process.env (D-33).
import fs from 'node:fs';
import path from 'node:path';

export function findExecutable(name: string, pathVar: string | undefined): string | null {
  if (!pathVar) return null;
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
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
