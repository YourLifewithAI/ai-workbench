// Boundary rules from spec/architecture.md, enforced by the check gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const banFs = ['node:fs', 'fs', 'node:fs/promises', 'fs/promises', 'node:net', 'net', 'node:child_process', 'child_process'];
const banVm = ['node:vm', 'vm'];
const sdk = ['ai', '@ai-sdk/*'];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'runlog/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': ['error', { paths: banVm.map((name) => ({ name, message: 'node:vm is banned (D-30).' })) }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // src/shared imports nothing from src/.
    files: ['src/shared/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['../runtime/*', '../ui/*', '**/runtime/**', '**/ui/**'], message: 'src/shared imports nothing from src/.' }], paths: banVm.map((name) => ({ name })) }] },
  },
  {
    // src/ui imports only src/shared and itself.
    files: ['src/ui/**/*.ts', 'src/ui/**/*.tsx'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['**/runtime/**'], message: 'src/ui imports only src/shared and its own files.' }], paths: banVm.map((name) => ({ name })) }] },
  },
  {
    // The runtime never imports the UI; the SDK lives only in adapters.
    files: ['src/runtime/**/*.ts'],
    ignores: ['src/runtime/models/adapters/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['**/ui/**'], message: 'src/runtime never imports src/ui.' }, { group: sdk, message: '`ai` and `@ai-sdk/*` are importable only inside src/runtime/models/adapters/.' }], paths: banVm.map((name) => ({ name })) }] },
  },
  {
    // Tools and the engine receive broker handles; they never touch fs, net, child processes, or global fetch.
    files: ['src/runtime/tools/**/*.ts', 'src/runtime/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/ui/**'] }, { group: sdk }], paths: [...banFs, ...banVm].map((name) => ({ name, message: 'tools/ and engine/ use broker handles, never node:fs, node:net, node:child_process, or node:vm.' })) }],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Use the injected fetch / broker handle.' }],
    },
  },
  {
    files: ['src/runtime/models/adapters/**/*.ts'],
    rules: { 'no-restricted-globals': ['error', { name: 'fetch', message: 'Adapters use the injected fetch only.' }] },
  },
  {
    // process.env is readable only in bootstrap and the credentials loader.
    files: ['src/**/*.ts', 'src/**/*.tsx', 'scripts/**/*.ts'],
    // scripts/contract.ts is dev tooling outside the runtime: it forwards the environment to a vitest child,
    // which is the one thing this rule cannot express. Nothing in dist/ is exempt.
    ignores: ['src/runtime/bootstrap.ts', 'src/runtime/security/credentials.ts', 'scripts/contract.ts'],
    rules: { 'no-restricted-properties': ['error', { object: 'process', property: 'env', message: 'process.env is readable only in src/runtime/bootstrap.ts and src/runtime/security/credentials.ts.' }] },
  },
);
