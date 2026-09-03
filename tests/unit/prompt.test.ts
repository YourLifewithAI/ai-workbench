import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { packagePaths } from '../../src/runtime/paths.js';
import { loadAgent, sectionsFromMarkdown } from '../../src/runtime/workspace/loader.js';
import { assemblePrompt } from '../../src/runtime/engine/prompt.js';
import { harnessSection } from '../../src/runtime/engine/harness.js';
import { tempDir } from '../helpers/workspace.js';

const echoDir = path.join(packagePaths().examplesWorkspace, 'agents', 'echo');

describe('prompt assembly (D-09, D-10, D-46)', () => {
  it('system = identity, instructions, harness last; task is the first user message; tools []', () => {
    const agent = loadAgent(echoDir);
    const harness = harnessSection({ agentId: 'echo', runId: 'r1', tools: [] });
    const p = assemblePrompt(agent, 'hello there', harness);
    expect(p.compiled.system.startsWith('## identity')).toBe(true);
    expect(p.compiled.system.trimEnd().endsWith(harness.trimEnd())).toBe(true);
    expect(p.compiled.system.indexOf('## task')).toBeLessThan(p.compiled.system.indexOf('## harness'));
    expect(p.compiled.messages).toHaveLength(1);
    expect(p.compiled.messages[0]?.role).toBe('user');
    expect(JSON.stringify(p.compiled.messages[0])).toContain('hello there');
    expect(p.compiled.tools).toEqual([]);
  });

  it('promptVersion ignores the run-specific harness and the task', () => {
    const agent = loadAgent(echoDir);
    const a = assemblePrompt(agent, 'x', harnessSection({ agentId: 'echo', runId: 'r1', tools: [] }));
    const b = assemblePrompt(agent, 'y', harnessSection({ agentId: 'echo', runId: 'r2', tools: [] }));
    expect(a.promptVersion).toBe(b.promptVersion);
    expect(a.promptVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('agent version changes when the instructions change', () => {
    const agent = loadAgent(echoDir);
    const copy = path.join(tempDir(), 'echo');
    fs.cpSync(echoDir, copy, { recursive: true });
    const file = path.join(copy, 'agent.json');
    const def = JSON.parse(fs.readFileSync(file, 'utf8')) as { instructions: { name: string; text: string }[] };
    def.instructions[0]!.text = 'Reply in French.';
    fs.writeFileSync(file, JSON.stringify(def));
    expect(loadAgent(copy).version).not.toBe(agent.version);
  });

  it('instructions.md splits into sections by ## headings', () => {
    const sections = sectionsFromMarkdown('## voice\nBe terse.\n\n## rules\nNo lists.\n');
    expect(sections).toEqual([{ name: 'voice', text: 'Be terse.' }, { name: 'rules', text: 'No lists.' }]);
  });
});
