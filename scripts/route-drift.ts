// The API surface and the document that describes it drift apart silently: RUN-10 shipped five routes it never
// wrote down, and `spec/api-and-cli.md` promised four that were never built. Both were found by hand, months
// late. This makes the comparison a gate, so the next one is found in the same commit that causes it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `:id`, `:slug`, `<id>` and `{id}` all mean "a parameter here"; the name is not the contract. */
const normalise = (route: string): string => route.replace(/[:{<][A-Za-z_]+[}>]?/g, ':p').replace(/\/+$/, '');

function implemented(): Set<string> {
  const source = fs.readFileSync(path.join(root, 'src/runtime/api/app.ts'), 'utf8');
  const found = new Set<string>();
  for (const m of source.matchAll(/app\.(get|post|put|patch|delete)\('(\/api\/v1\/[^']*)'/g)) {
    found.add(`${m[1]!.toUpperCase()} ${normalise(m[2]!.replace('/api/v1', ''))}`);
  }
  return found;
}

function documented(): Set<string> {
  const raw = fs.readFileSync(path.join(root, 'spec/api-and-cli.md'), 'utf8');
  // Fenced blocks first. Pairing inline backticks across a ``` fence shifts every pair after it, which
  // silently drops real routes — and a gate that reports a route missing because its own parser lost the
  // thread is worse than no gate. The fences hold CLI examples, not HTTP routes, so dropping them is right.
  const doc = raw.replace(/```[\s\S]*?```/g, '\n');
  const found = new Set<string>();
  // Only inside backticks: prose that happens to say "GET /runs" is not a claim about the surface.
  for (const tick of doc.matchAll(/`([^`]+)`/g)) {
    for (const m of tick[1]!.matchAll(/\b(GET|POST|PUT|PATCH|DELETE) (\/[A-Za-z0-9:/_.{}<>-]+)/g)) {
      const route = m[2]!.replace(/^\/api\/v1/, '');
      if (!route.startsWith('/')) continue;
      found.add(`${m[1]} ${normalise(route)}`);
    }
  }
  return found;
}

const code = implemented();
const doc = documented();
const missing = [...doc].filter((r) => !code.has(r)).sort();
const undocumented = [...code].filter((r) => !doc.has(r)).sort();

if (missing.length === 0 && undocumented.length === 0) {
  console.log(`route-drift: clean (${code.size} routes, documented and implemented agree)`);
  process.exit(0);
}
if (missing.length) {
  console.error(`\nspec/api-and-cli.md documents ${missing.length} route(s) that do not exist:`);
  for (const r of missing) console.error(`  ${r}`);
}
if (undocumented.length) {
  console.error(`\nsrc/runtime/api/app.ts implements ${undocumented.length} route(s) that are not documented:`);
  for (const r of undocumented) console.error(`  ${r}`);
}
console.error('\nEither build it, delete the claim, or write it down.');
process.exit(1);
