// Where shipped assets live, in dev (tsx from src/) and in the built bin (dist/).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export interface PackagePaths {
  root: string;
  migrations: string;
  defaults: string;
  examplesWorkspace: string;
  uiDist: string;
  version: string;
}

export function packagePaths(): PackagePaths {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const isDist = path.basename(here) === 'dist' || here.includes(`${path.sep}dist${path.sep}`);
  const root = isDist ? path.resolve(here, '..') : path.resolve(here, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
  return isDist
    ? { root, migrations: path.join(root, 'dist', 'migrations'), defaults: path.join(root, 'dist', 'defaults'), examplesWorkspace: path.join(root, 'dist', 'examples', 'workspace'), uiDist: path.join(root, 'dist', 'ui'), version: pkg.version }
    : { root, migrations: path.join(root, 'src', 'runtime', 'db', 'migrations'), defaults: path.join(root, 'defaults'), examplesWorkspace: path.join(root, 'examples', 'workspace'), uiDist: path.join(root, 'dist', 'ui'), version: pkg.version };
}

export interface WorkspacePaths {
  dir: string;
  workspaceFile: string;
  config: string;
  workbenchJson: string;
  modelsJson: string;
  credentialsJson: string;
  agents: string;
  workflows: string;
  projects: string;
  fixtures: string;
  plugins: string;
  data: string;
  db: string;
  backups: string;
  logs: string;
  logFile: string;
  runtimeToken: string;
  runtimeJson: string;
  runs: string;
  exports: string;
}

export function workspacePaths(dir: string): WorkspacePaths {
  const d = path.resolve(dir);
  const data = path.join(d, 'data');
  return {
    dir: d,
    workspaceFile: path.join(d, 'workspace.json'),
    config: path.join(d, 'config'),
    workbenchJson: path.join(d, 'config', 'workbench.json'),
    modelsJson: path.join(d, 'config', 'models.json'),
    credentialsJson: path.join(d, 'config', 'credentials.json'),
    agents: path.join(d, 'agents'),
    workflows: path.join(d, 'workflows'),
    projects: path.join(d, 'projects'),
    fixtures: path.join(d, 'fixtures'),
    plugins: path.join(d, 'plugins'),
    data,
    db: path.join(data, 'workbench.sqlite'),
    backups: path.join(data, 'backups'),
    logs: path.join(data, 'logs'),
    logFile: path.join(data, 'logs', 'runtime.log'),
    runtimeToken: path.join(data, 'runtime.token'),
    runtimeJson: path.join(data, 'runtime.json'),
    runs: path.join(d, 'runs'),
    exports: path.join(d, 'exports'),
  };
}
