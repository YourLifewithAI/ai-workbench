// What tools exist. Built-ins only for now; MCP servers and plugins join the same map in RUN-09 and RUN-11,
// with the same grant model, so nothing here should assume a tool came from this file.
import type { ToolDefinition } from '../../shared/tool.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { calc, datetime, json } from './builtin/basics.js';
import { artifactTools } from './builtin/artifacts.js';
import { delegateTool, permissionRequestTool, type DelegateHost, type PermissionRequestHost } from './builtin/delegate.js';
import { webTools, type WebToolDeps } from './builtin/web.js';
import { memoryTools, type MemoryToolDeps } from './builtin/memory.js';

export interface RegistryDeps {
  artifacts: ArtifactStore;
  workspaceDir: string;
  delegate: DelegateHost;
  permissions: PermissionRequestHost;
  /** The two network tools (RUN-07). Absent leaves them out of the catalogue entirely. */
  web?: WebToolDeps | undefined;
  /** Memory and knowledge (RUN-08). Absent leaves them out, and a prompt then carries no memory sections. */
  memory?: MemoryToolDeps | undefined;
}

export function builtinTools(deps: RegistryDeps): Map<string, ToolDefinition> {
  const tools: ToolDefinition[] = [
    calc as ToolDefinition,
    datetime as ToolDefinition,
    json as ToolDefinition,
    ...artifactTools({ artifacts: deps.artifacts, workspaceDir: deps.workspaceDir }),
    delegateTool(deps.delegate),
    permissionRequestTool(deps.permissions),
    ...(deps.web ? webTools(deps.web) : []),
    ...(deps.memory ? memoryTools(deps.memory) : []),
  ];
  return new Map(tools.map((t) => [t.id, t]));
}
