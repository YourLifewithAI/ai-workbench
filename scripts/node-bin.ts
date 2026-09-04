// Resolving a package's own JS entry, so a tool is run as `node <entry>` rather than through its shim.
//
// Since CVE-2024-27980 Node refuses to spawn a `.cmd` or `.bat` without `shell: true`, and on Windows every
// `node_modules/.bin` shim is a `.cmd`. The failure is quiet in the worst way: spawnSync returns
// `status: null` with `stderr: undefined`, so a caller checking `status !== 0` reports the tool's own failure
// rather than the fact that it never started. Four call sites hit this on the first Windows run.
//
// `shell: true` would also work and is not used here: it puts every argument through cmd.exe parsing, which is
// a poor default for anything that later grows a variable argument.
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** The absolute path to a package's executable JS, resolved from its own `bin` field. */
export function binEntry(pkg: string, bin = pkg): string {
  const manifest = require.resolve(`${pkg}/package.json`);
  const json = require(`${pkg}/package.json`) as { bin?: string | Record<string, string> };
  const rel = typeof json.bin === 'string' ? json.bin : json.bin?.[bin];
  if (!rel) throw new Error(`${pkg} declares no bin entry for "${bin}"`);
  return path.join(path.dirname(manifest), rel);
}
