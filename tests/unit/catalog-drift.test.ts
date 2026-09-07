// The shipped catalog against a workspace's own copy (D-64's second source).
//
// The gap this closes: `init` copies `defaults/models.json` into a workspace once and nothing updates it
// afterwards, so every later correction stopped at the workspace boundary. It was found the day
// `capabilities.thinking` shipped — the adapter fix reached the owner, the catalog fact it depends on did not,
// and their capable models quietly stopped asking for extended thinking. A provider listing cannot close it:
// no API reports how it wants to be *asked*, so the shipped catalog is the only source of that fact.
//
// The rule these tests pin down is the one that makes it safe to run on every load: it proposes, it never
// writes, and it never argues with a number or a flag someone chose.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { diffShipped, applyFinding } from '../../src/runtime/models/discovery.js';
import { ModelsFile, type CatalogEntry } from '../../src/shared/model.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { packagePaths } from '../../src/runtime/paths.js';

const shipped = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const entry = (id: string): CatalogEntry => structuredClone(shipped.models.find((m) => m.id === id)!);
const diff = (models: CatalogEntry[]) => diffShipped({ catalog: { schemaVersion: 1, models }, shipped, pins: new Map(), now: new Date('2026-09-07T00:00:00Z') });

describe('a workspace catalog against the shipped one', () => {
  it('says nothing when the workspace is the shipped catalog', () => {
    expect(diff(structuredClone(shipped.models))).toEqual([]);
  });

  it('the owner\'s exact case: a workspace made before `thinking` existed is told, per model', () => {
    // What their config/models.json looked like — every Anthropic entry without the field.
    const models = structuredClone(shipped.models);
    for (const m of models) delete (m.capabilities as { thinking?: unknown }).thinking;

    const findings = diff(models);
    const drifts = findings.filter((f) => f.kind === 'drift');
    expect(drifts.length, 'one per model that ships a thinking form').toBe(shipped.models.filter((m) => m.capabilities.thinking !== undefined).length);
    expect(drifts.length).toBeGreaterThan(0);

    const haiku = drifts.find((f) => f.modelId === 'anthropic/claude-haiku-4-5');
    expect(haiku, 'Haiku 4.5 is named').toBeDefined();
    expect(haiku!.source).toBe('shipped');
    expect(haiku!.detail).toContain('thinking');
    expect(haiku!.detail).toContain('unset → budget');
    expect(haiku!.proposed).toEqual({ capabilities: { thinking: 'budget' } });

    // And accepting it produces exactly the shipped value — the fix actually lands.
    const after = applyFinding({ schemaVersion: 1, models }, haiku!, new Date());
    expect(after.models.find((m) => m.id === 'anthropic/claude-haiku-4-5')!.capabilities.thinking).toBe('budget');
  });

  it('a model the workspace has never heard of is offered, disabled and with its price', () => {
    const models = structuredClone(shipped.models).filter((m) => m.id !== 'anthropic/claude-sonnet-5');
    const found = diff(models).filter((f) => f.kind === 'new');
    expect(found.map((f) => f.modelId)).toEqual(['anthropic/claude-sonnet-5']);
    expect(found[0]!.source).toBe('shipped');

    const after = applyFinding({ schemaVersion: 1, models }, found[0]!, new Date());
    const added = after.models.find((m) => m.id === 'anthropic/claude-sonnet-5')!;
    expect(added.enabled, 'a model arrives off, the way discovery adds one (D-64)').toBe(false);
    expect(added.capabilities.thinking).toBe('adaptive');
  });

  it('never argues with a choice: a disabled entry is left alone entirely', () => {
    const models = structuredClone(shipped.models);
    const haiku = models.find((m) => m.id === 'anthropic/claude-haiku-4-5')!;
    haiku.enabled = false;
    delete (haiku.capabilities as { thinking?: unknown }).thinking;
    haiku.capabilities.contextTokens = 12345; // a deliberate local edit

    expect(diff(models).filter((f) => f.modelId === 'anthropic/claude-haiku-4-5')).toEqual([]);
  });

  it('never overwrites a price someone typed, and offers one only where there is none', () => {
    const models = structuredClone(shipped.models);
    const typed = models.find((m) => m.id === 'anthropic/claude-opus-5')!;
    typed.pricing = [{ effectiveFrom: '2026-01-01T00:00:00Z', inputPerM: 1, outputPerM: 2 }];
    const unpriced = models.find((m) => m.id === 'anthropic/claude-sonnet-5')!;
    unpriced.pricing = [];

    const priced = diff(models).filter((f) => f.kind === 'repriced');
    expect(priced.map((f) => f.modelId), 'only the entry with no price at all').toEqual(['anthropic/claude-sonnet-5']);
    expect(priced[0]!.detail).toContain('cannot run');
  });

  it('a model the workspace added and the shipped catalog does not know is never touched', () => {
    const mine = { ...entry('anthropic/claude-opus-5'), id: 'anthropic/my-own-tune' };
    const models = [...structuredClone(shipped.models), mine];
    expect(diff(models).filter((f) => f.modelId === 'anthropic/my-own-tune')).toEqual([]);
  });

  it('its ids cannot collide with the provider path\'s, so one dismissal never silences the other', () => {
    const models = structuredClone(shipped.models);
    delete (models.find((m) => m.id === 'anthropic/claude-haiku-4-5')!.capabilities as { thinking?: unknown }).thinking;
    for (const f of diff(models)) expect(f.id.startsWith('shipped:'), f.id).toBe(true);
  });

  it('the facts hash moves when the proposal moves, so a dismissal lapses rather than sticking forever', () => {
    const before = structuredClone(shipped.models);
    delete (before.find((m) => m.id === 'anthropic/claude-haiku-4-5')!.capabilities as { thinking?: unknown }).thinking;
    const first = diff(before).find((f) => f.id === 'shipped:drift:anthropic/claude-haiku-4-5')!;

    const after = structuredClone(before);
    after.find((m) => m.id === 'anthropic/claude-haiku-4-5')!.capabilities.contextTokens = 999;
    const second = diff(after).find((f) => f.id === 'shipped:drift:anthropic/claude-haiku-4-5')!;

    expect(second.factsHash).not.toBe(first.factsHash);
  });

  it('the shipped catalog itself declares a thinking form for every Anthropic entry', () => {
    // The guard on the data rather than the code: an entry added without it would silently get no thinking.
    for (const m of shipped.models.filter((m) => m.adapter === 'anthropic')) {
      expect(m.capabilities.thinking, `${m.id}`).toBeDefined();
    }
  });
});
