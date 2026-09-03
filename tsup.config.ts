import { defineConfig } from 'tsup';
import { cpSync, mkdirSync } from 'node:fs';

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
    cpSync('src/runtime/db/migrations', 'dist/migrations', { recursive: true });
    cpSync('defaults', 'dist/defaults', { recursive: true });
    cpSync('examples', 'dist/examples', { recursive: true });
  },
});
