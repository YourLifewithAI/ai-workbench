// Loads and validates the private workspace (spec/architecture.md §Workspace contract, D-24).
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceFile, type WorkbenchConfig } from '../../shared/workspace.js';
import { ModelsFile } from '../../shared/model.js';
import { Agent, type InstructionSection, type LoadedAgent } from '../../shared/agent.js';
import { Workflow, validateWorkflow, type LoadedWorkflow } from '../../shared/workflow.js';
import { workspacePaths, type WorkspacePaths } from '../paths.js';
import { loadConfig, readJsonFile } from './config.js';
import { WorkspaceError, formatZodError } from '../util/errors.js';
import { contentHash } from '../util/canonical.js';
import { ensureVapidKeys } from '../push/vapid.js';
import { loadSpaces, type BrokenSpace, type LoadedSpace } from './spaces.js';

export interface BrokenAgent { id: string; file: string; message: string }
export interface BrokenWorkflow { id: string; file: string; message: string }

export interface Workspace {
  paths: WorkspacePaths;
  file: WorkspaceFile;
  config: WorkbenchConfig;
  catalog: ModelsFile;
  agents: Map<string, LoadedAgent>;
  brokenAgents: BrokenAgent[];
  workflows: Map<string, LoadedWorkflow>;
  brokenWorkflows: BrokenWorkflow[];
  /** Project spaces (D-69): the projects that carry a `project.json`, by slug. */
  spaces: Map<string, LoadedSpace>;
  brokenSpaces: BrokenSpace[];
}

export function loadWorkspace(dir: string, defaultsDir: string): Workspace {
  const paths = workspacePaths(dir);
  if (!fs.existsSync(paths.workspaceFile)) {
    throw new WorkspaceError(paths.workspaceFile, `not found. Is "${paths.dir}" a workspace? Create one with: workbench init <path>`);
  }
  const wsParsed = WorkspaceFile.safeParse(readJsonFile(paths.workspaceFile));
  if (!wsParsed.success) throw formatZodError(paths.workspaceFile, wsParsed.error);
  if (!fs.existsSync(paths.workbenchJson)) throw new WorkspaceError(paths.workbenchJson, 'not found (it may be `{ "schemaVersion": 1 }`)');
  if (!fs.existsSync(paths.modelsJson)) throw new WorkspaceError(paths.modelsJson, 'not found. Copy defaults/models.json here.');

  const config = loadConfig(path.join(defaultsDir, 'workbench.json'), paths.workbenchJson);
  const catalogParsed = ModelsFile.safeParse(readJsonFile(paths.modelsJson));
  if (!catalogParsed.success) throw formatZodError(paths.modelsJson, catalogParsed.error);

  for (const d of [paths.agents, paths.workflows, paths.projects, paths.fixtures, paths.plugins, paths.data, paths.backups, paths.logs, paths.runs, paths.exports]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const { agents, broken } = loadAgents(paths.agents);
  const workflows = loadWorkflows(paths.workflows);
  const spaces = loadSpaces(paths.projects);
  return {
    paths, file: wsParsed.data, config, catalog: catalogParsed.data,
    agents, brokenAgents: broken, workflows: workflows.workflows, brokenWorkflows: workflows.broken,
    spaces: spaces.spaces, brokenSpaces: spaces.broken,
  };
}

/**
 * `<workflows>/<id>.workflow.json`. A file that does not parse or does not validate is listed as broken rather
 * than thrown: one bad workflow must not stop the runtime from loading the rest of the workspace.
 */
export function loadWorkflows(workflowsDir: string): { workflows: Map<string, LoadedWorkflow>; broken: BrokenWorkflow[] } {
  const workflows = new Map<string, LoadedWorkflow>();
  const broken: BrokenWorkflow[] = [];
  if (!fs.existsSync(workflowsDir)) return { workflows, broken };
  for (const entry of fs.readdirSync(workflowsDir).sort()) {
    if (!entry.endsWith('.workflow.json')) continue;
    const file = path.join(workflowsDir, entry);
    const id = entry.slice(0, -'.workflow.json'.length);
    try {
      workflows.set(id, loadWorkflow(file, id));
    } catch (e) {
      broken.push({ id, file, message: (e as Error).message });
    }
  }
  return { workflows, broken };
}

export function loadWorkflow(file: string, expectedId?: string): LoadedWorkflow {
  const parsed = Workflow.safeParse(readJsonFile(file));
  if (!parsed.success) throw formatZodError(file, parsed.error);
  const definition = parsed.data;
  const id = expectedId ?? definition.id;
  if (definition.id !== id) throw new WorkspaceError(file, `id "${definition.id}" must match the file name "${id}.workflow.json"`);
  const result = validateWorkflow(definition);
  if (result.errors.length) {
    throw new WorkspaceError(file, result.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }
  return { definition, version: contentHash({ definition }), file };
}

export function loadAgents(agentsDir: string): { agents: Map<string, LoadedAgent>; broken: BrokenAgent[] } {
  const agents = new Map<string, LoadedAgent>();
  const broken: BrokenAgent[] = [];
  if (!fs.existsSync(agentsDir)) return { agents, broken };
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(agentsDir, entry.name);
    const file = path.join(dir, 'agent.json');
    if (!fs.existsSync(file)) continue;
    try {
      agents.set(entry.name, loadAgent(dir));
    } catch (e) {
      broken.push({ id: entry.name, file, message: (e as Error).message });
    }
  }
  return { agents, broken };
}

export function loadAgent(dir: string): LoadedAgent {
  const file = path.join(dir, 'agent.json');
  const parsed = Agent.safeParse(readJsonFile(file));
  if (!parsed.success) throw formatZodError(file, parsed.error);
  const definition = parsed.data;
  if (definition.id !== path.basename(dir)) {
    throw new WorkspaceError(file, `id "${definition.id}" must match the directory name "${path.basename(dir)}"`);
  }
  let sections: InstructionSection[];
  let instructionsMd: string | undefined;
  if (Array.isArray(definition.instructions)) {
    sections = definition.instructions;
  } else {
    const mdFile = path.join(dir, 'instructions.md');
    if (!fs.existsSync(mdFile)) throw new WorkspaceError(file, 'instructions.file names instructions.md but it does not exist');
    instructionsMd = fs.readFileSync(mdFile, 'utf8');
    sections = sectionsFromMarkdown(instructionsMd);
  }
  const version = contentHash({ definition, instructionsMd });
  return { definition, sections, version, dir };
}

/** `## Heading` blocks become named sections; text before the first heading is the `instructions` section. */
export function sectionsFromMarkdown(md: string): InstructionSection[] {
  const out: InstructionSection[] = [];
  let name = 'instructions';
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out.push({ name, text });
    buf = [];
  };
  for (const line of md.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1]!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
    } else buf.push(line);
  }
  flush();
  return out.length ? out : [{ name: 'instructions', text: '' }];
}

export function initWorkspace(targetDir: string, examplesDir: string, defaultsDir: string, name?: string): WorkspacePaths {
  const paths = workspacePaths(targetDir);
  if (fs.existsSync(paths.workspaceFile)) throw new WorkspaceError(paths.workspaceFile, 'already exists; refusing to overwrite a workspace');
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.cpSync(examplesDir, paths.dir, { recursive: true, errorOnExist: false, force: false });
  fs.mkdirSync(paths.config, { recursive: true });
  if (!fs.existsSync(paths.workbenchJson)) fs.writeFileSync(paths.workbenchJson, '{ "schemaVersion": 1 }\n');
  fs.copyFileSync(path.join(defaultsDir, 'models.json'), paths.modelsJson);
  const wsFile: WorkspaceFile = { schemaVersion: 1, name: name ?? path.basename(paths.dir), createdAt: new Date().toISOString() };
  fs.writeFileSync(paths.workspaceFile, JSON.stringify(wsFile, null, 2) + '\n');
  // The notification keys are generated once, here, and never rotated: rotating would silently deafen every
  // device that had subscribed (D-61).
  ensureVapidKeys(paths.dir);
  for (const d of [paths.agents, paths.workflows, paths.projects, paths.fixtures, paths.plugins, paths.data, paths.backups, paths.logs, paths.runs, paths.exports]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return paths;
}
