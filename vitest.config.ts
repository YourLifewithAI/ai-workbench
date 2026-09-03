import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'security', include: ['tests/security/**/*.test.ts'], environment: 'node', testTimeout: 30000 } },
      { test: { name: 'dod', include: ['tests/dod/**/*.test.ts'], environment: 'node', testTimeout: 120000 } },
    ],
  },
});
