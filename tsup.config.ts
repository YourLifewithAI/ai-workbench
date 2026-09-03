import { defineConfig } from 'tsup';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

export default defineConfig({
  entry: { server: 'src/runtime/server.ts', cli: 'src/runtime/cli/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: false,
  splitting: false,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3'],
  onSuccess: async () => {
    mkdirSync('dist', { recursive: true });
    // Each copied tree is emptied first: `cpSync` overwrites what is there and leaves what is not, so a file
    // deleted or renamed in the source stayed in `dist/` and kept being loaded — a stale example workspace is
    // shipped to whoever runs `workbench init` next.
    for (const [from, to] of [['src/runtime/db/migrations', 'dist/migrations'], ['defaults', 'dist/defaults'], ['examples', 'dist/examples']]) {
      rmSync(to!, { recursive: true, force: true });
      cpSync(from!, to!, { recursive: true });
    }
  },
});
