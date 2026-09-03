// Export and import touch the workspace directly, like `init` and `doctor`, rather than through the HTTP API:
// they move whole folders, and an ephemeral runtime would be the wrong shape for that.
import { packagePaths, workspacePaths } from '../paths.js';
import { openDatabase } from '../db/index.js';
import { loadWorkspace } from '../workspace/loader.js';
import { Redactor } from '../security/redaction.js';
import { loadCredentials } from '../security/credentials.js';
import { ArtifactStore } from '../artifacts/store.js';

export interface OpenedStore { store: ArtifactStore; close: () => Promise<void> }

export async function openWorkspaceStore(workspaceDir: string): Promise<OpenedStore> {
  const pkg = packagePaths();
  const workspace = loadWorkspace(workspaceDir, pkg.defaults);
  const redactor = new Redactor();
  // Registering credentials keeps a planted secret out of anything this command writes (D-33).
  loadCredentials(workspace.paths.credentialsJson, redactor);
  const { db } = await openDatabase({
    file: workspace.paths.db,
    migrationsDir: pkg.migrations,
    backupsDir: workspace.paths.backups,
    keepBackups: workspace.config.retention.backups,
  });
  const store = new ArtifactStore(db, workspacePaths(workspaceDir).projects, redactor);
  store.adoptProjectDirectories();
  return { store, close: async () => { db.close(); } };
}
