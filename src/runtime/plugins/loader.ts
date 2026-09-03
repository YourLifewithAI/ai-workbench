// Plugins (D-32). A plugin is trusted code with the runtime's authority — not a sandboxed tool, not an MCP
// server in its own process, but a module this process imports. That is a real decision with a real cost, so:
// it loads only from `<workspace>/plugins/`, its version is pinned in the manifest, a postinstall script is
// refused outright, and a human is shown the words "this code runs with full access" before it is loaded the
// first time. The acknowledgement is stored per plugin *and version*, so a new version asks again.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Logger } from '../log/index.js';
import type { ToolDefinition } from '../../shared/tool.js';
import type { ModelAdapter } from '../models/adapter.js';

export const PluginManifest = z.object({
  schemaVersion: z.literal(1),
  name: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens'),
  version: z.string().min(1),
  kind: z.enum(['adapter', 'tool', 'evaluator']),
  entry: z.string().regex(/^[A-Za-z0-9._/-]+\.(js|mjs)$/, 'a .js or .mjs file inside the plugin directory'),
  /** What it says it needs. Shown to the human; it grants nothing by itself. */
  capabilities: z.array(z.string()).default([]),
  description: z.string().optional(),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

export interface PluginStatus {
  name: string;
  version: string;
  kind: PluginManifest['kind'];
  capabilities: string[];
  description: string | null;
  /** Loaded, or refused with a reason a person can act on. */
  loaded: boolean;
  error: string | null;
  /** False until a human has been shown the warning for *this version* and said yes. */
  acknowledged: boolean;
  /** The words a person is shown before it runs. Kept here so the UI and the CLI say the same thing. */
  warning: string;
}

export const PLUGIN_WARNING = 'This code runs with full access: it is loaded into the workbench itself, not into the sandbox, and can do anything the workbench can do — read your credentials file, reach the network, and change anything in this workspace. Load it only if you trust whoever wrote it.';

export interface LoaderDeps {
  pluginsDir: string;
  log: Logger;
  /** `plugin@version` strings a human has acknowledged, from config. */
  acknowledged: () => string[];
}

export const acknowledgementKey = (manifest: { name: string; version: string }): string => `${manifest.name}@${manifest.version}`;

export interface LoadedPlugins {
  tools: ToolDefinition[];
  adapters: ModelAdapter[];
  statuses: PluginStatus[];
}

export class PluginLoader {
  constructor(private readonly deps: LoaderDeps) {}

  /** Every plugin directory: what it says it is, whether it may run, and what it produced if it did. */
  async load(): Promise<LoadedPlugins> {
    const out: LoadedPlugins = { tools: [], adapters: [], statuses: [] };
    if (!fs.existsSync(this.deps.pluginsDir)) return out;
    const acknowledged = new Set(this.deps.acknowledged());

    for (const entry of fs.readdirSync(this.deps.pluginsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.deps.pluginsDir, entry.name);
      const manifestFile = path.join(dir, 'plugin.json');

      let manifest: PluginManifest;
      try {
        const parsed = PluginManifest.safeParse(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        manifest = parsed.data;
      } catch (e) {
        out.statuses.push(this.refused(entry.name, `plugin.json is missing or invalid: ${(e as Error).message}`));
        continue;
      }

      const problem = this.refuse(dir, manifest, entry.name);
      if (problem) { out.statuses.push({ ...this.describe(manifest), loaded: false, error: problem, acknowledged: acknowledged.has(acknowledgementKey(manifest)) }); continue; }

      if (!acknowledged.has(acknowledgementKey(manifest))) {
        out.statuses.push({
          ...this.describe(manifest), loaded: false, acknowledged: false,
          error: `Not loaded: nobody has acknowledged that ${acknowledgementKey(manifest)} runs with full access. Do that in Settings, or with \`workbench plugins trust ${manifest.name}\`.`,
        });
        continue;
      }

      try {
        const module = (await import(pathToFileURL(path.join(dir, manifest.entry)).href)) as { default?: unknown };
        const value = module.default;
        if (!value) throw new Error(`${manifest.entry} has no default export`);
        if (manifest.kind === 'tool') {
          const tools = (Array.isArray(value) ? value : [value]) as ToolDefinition[];
          for (const tool of tools) {
            if (!tool || typeof tool.id !== 'string' || typeof tool.execute !== 'function') throw new Error('a tool plugin default-exports a ToolDefinition, or an array of them');
            // The plugin's own name is in the tool id, so a grant is per plugin and per tool.
            out.tools.push({ ...tool, id: tool.id.startsWith(`${manifest.name}.`) ? tool.id : `${manifest.name}.${tool.id}` });
          }
        } else if (manifest.kind === 'adapter') {
          const adapter = value as ModelAdapter;
          if (typeof adapter.id !== 'string' || typeof adapter.stream !== 'function') throw new Error('an adapter plugin default-exports a ModelAdapter');
          out.adapters.push(adapter);
        }
        // An evaluator plugin has nothing to register yet: RUN-10's evaluators are a closed union, and widening
        // it is a decision rather than a load-time surprise.
        out.statuses.push({ ...this.describe(manifest), loaded: true, error: null, acknowledged: true });
        this.deps.log.info({ plugin: manifest.name, version: manifest.version, kind: manifest.kind }, 'plugin loaded with full access');
      } catch (e) {
        out.statuses.push({ ...this.describe(manifest), loaded: false, acknowledged: true, error: `it did not load: ${(e as Error).message}` });
        this.deps.log.warn({ plugin: manifest.name, err: e }, 'a plugin failed to load');
      }
    }
    return out;
  }

  /** The reasons a plugin does not get to run, checked before anything of its is imported. */
  private refuse(dir: string, manifest: PluginManifest, directoryName: string): string | null {
    if (manifest.name !== directoryName) return `its plugin.json calls it "${manifest.name}" but it lives in "${directoryName}/". The directory name is the name.`;

    const entry = path.resolve(dir, manifest.entry);
    // The entry has to be inside the plugin's own directory, `..` and symlinks included: a plugin that loads
    // code from elsewhere is not the thing the human looked at.
    const realDir = fs.realpathSync(dir);
    if (!fs.existsSync(entry)) return `its entry "${manifest.entry}" is not there.`;
    const realEntry = fs.realpathSync(entry);
    if (realEntry !== realDir && !realEntry.startsWith(realDir + path.sep)) return `its entry resolves outside the plugin directory (${realEntry}).`;

    const packageFile = path.join(dir, 'package.json');
    if (fs.existsSync(packageFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { scripts?: Record<string, string>; version?: string };
        // A postinstall is code that runs at install time, before any human has looked at anything (D-32).
        const forbidden = ['postinstall', 'preinstall', 'install', 'prepare'].filter((s) => pkg.scripts?.[s]);
        if (forbidden.length) return `its package.json has ${forbidden.join(' and ')} script(s), which run before anyone can read the code. Remove them.`;
        if (pkg.version && pkg.version !== manifest.version) return `its package.json says version ${pkg.version} and its plugin.json says ${manifest.version}.`;
      } catch (e) {
        return `its package.json is not readable: ${(e as Error).message}`;
      }
    }
    if (/^[\^~*]|x$/.test(manifest.version)) return `its version "${manifest.version}" is a range. A plugin's version is pinned exactly, so what you acknowledged is what runs.`;
    return null;
  }

  private describe(manifest: PluginManifest): Omit<PluginStatus, 'loaded' | 'error' | 'acknowledged'> {
    return {
      name: manifest.name, version: manifest.version, kind: manifest.kind,
      capabilities: manifest.capabilities, description: manifest.description ?? null,
      warning: PLUGIN_WARNING,
    };
  }

  private refused(name: string, error: string): PluginStatus {
    return { name, version: '?', kind: 'tool', capabilities: [], description: null, loaded: false, error, acknowledged: false, warning: PLUGIN_WARNING };
  }
}
