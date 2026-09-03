// Prompt assembly (spec/agents-and-prompts.md, D-09, D-10, D-46): sections in order, the task as the first user message.
import type { CompiledRequest, Message } from '../../shared/model.js';
import type { LoadedAgent } from '../../shared/agent.js';
import { contentHash } from '../util/canonical.js';

export interface AssembledPrompt {
  compiled: CompiledRequest;
  promptVersion: string;
  sections: { name: string; text: string }[];
}

export function renderSection(name: string, text: string): string {
  return `## ${name}\n${text.trim()}`;
}

export function assemblePrompt(agent: LoadedAgent, task: string, harness: string): AssembledPrompt {
  const identity = `${agent.definition.name}: ${agent.definition.description}`;
  const stable = [{ name: 'identity', text: identity }, ...agent.sections.map((s) => ({ name: s.name, text: s.text }))];
  const promptVersion = contentHash({ identity, instructions: agent.sections });
  const sections = [...stable, { name: 'harness', text: harness }].filter((s) => s.text.trim().length > 0);
  const system = sections.map((s) => renderSection(s.name, s.text)).join('\n\n');
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: task }] }];
  return { compiled: { system, messages, tools: [] }, promptVersion, sections };
}
