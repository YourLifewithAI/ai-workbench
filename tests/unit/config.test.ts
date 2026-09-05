import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { deepMerge, loadConfig } from '../../src/runtime/workspace/config.js';
import { packagePaths } from '../../src/runtime/paths.js';
import { tempDir } from '../helpers/workspace.js';

const defaultsFile = path.join(packagePaths().defaults, 'workbench.json');

describe('config precedence (D-20)', () => {
  it('deepMerge merges objects and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] })).toEqual({ a: { b: 1, c: 3 }, list: [9] });
  });

  it('workspace values override defaults; everything else stays', () => {
    const file = path.join(tempDir(), 'workbench.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, budgets: { maxCostUsd: 0.5 } }));
    const cfg = loadConfig(defaultsFile, file);
    expect(cfg.budgets.maxCostUsd).toBe(0.5);
    expect(cfg.budgets.maxModelCalls).toBe(60);
    expect(cfg.network.mode).toBe('allowlist');
  });

  it('a minimal workspace file yields the full defaults', () => {
    const file = path.join(tempDir(), 'workbench.json');
    fs.writeFileSync(file, '{ "schemaVersion": 1 }');
    const cfg = loadConfig(defaultsFile, file);
    expect(cfg.execution.escalation).toBe('sensitive-only');
    expect(cfg.retention.backups).toBe(5);
  });

  it('errors name the file and the JSON path', () => {
    const file = path.join(tempDir(), 'workbench.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, budgets: { maxCostUsd: 'lots' } }));
    expect(() => loadConfig(defaultsFile, file)).toThrow(/workbench\.json/);
    expect(() => loadConfig(defaultsFile, file)).toThrow(/budgets\.maxCostUsd/);
  });
});

describe('discovery providers (D-64)', () => {
  it('ships OpenAI, Qwen and Kimi as providers a key alone makes askable', () => {
    const dir = tempDir('wb-cfg');
    fs.writeFileSync(path.join(dir, 'workbench.json'), JSON.stringify({ schemaVersion: 1 }));
    const config = loadConfig(defaultsFile, path.join(dir, 'workbench.json'));
    expect(Object.keys(config.discovery.providers).sort()).toEqual(['kimi', 'openai', 'qwen']);
    expect(config.discovery.providers['openai']).toEqual({ adapter: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' });
  });
});

