// SQLite via better-sqlite3: WAL, FTS5 asserted, numbered migrations after an online backup (D-18, D-19).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  file: string;
  migrationsDir: string;
  backupsDir: string;
  keepBackups: number;
  /** Injectable so a test can simulate a build without FTS5 (RUN-00 DoD 7). */
  assertFts5?: (db: Db) => void;
}

export class DatabaseNewerError extends Error {
  constructor(public readonly dbVersion: number, public readonly runtimeVersion: number) {
    super(`The workspace database is at schema version ${dbVersion}, newer than this runtime's ${runtimeVersion}. Upgrade the runtime, or restore a backup from data/backups/.`);
    this.name = 'DatabaseNewerError';
  }
}

export function defaultAssertFts5(db: Db): void {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x); DROP TABLE temp.__fts5_probe;');
  } catch (e) {
    throw new Error(`This SQLite build lacks FTS5, which AI Workbench requires for search. Reinstall better-sqlite3 with a bundled SQLite (npm rebuild better-sqlite3). Underlying error: ${(e as Error).message}`);
  }
}

interface Migration { version: number; name: string; sql: string }

function readMigrations(dir: string): Migration[] {
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  return files.map((f) => ({ version: Number(f.slice(0, 4)), name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

export async function openDatabase(opts: OpenDatabaseOptions): Promise<{ db: Db; applied: number[]; backup: string | null }> {
  const existed = fs.existsSync(opts.file);
  fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  const db = new Database(opts.file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  (opts.assertFts5 ?? defaultAssertFts5)(db);

  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const migrations = readMigrations(opts.migrationsDir);
  const runtimeVersion = migrations.length ? migrations[migrations.length - 1]!.version : 0;
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
  const dbVersion = row.v;
  if (dbVersion > runtimeVersion) {
    db.close();
    throw new DatabaseNewerError(dbVersion, runtimeVersion);
  }
  const pending = migrations.filter((m) => m.version > dbVersion);
  let backup: string | null = null;
  if (pending.length && existed) {
    fs.mkdirSync(opts.backupsDir, { recursive: true });
    const target = pending[pending.length - 1]!.version;
    backup = path.join(opts.backupsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-pre-${target}.sqlite`);
    await db.backup(backup);
    pruneBackups(opts.backupsDir, opts.keepBackups);
  }
  if (pending.length) {
    const apply = db.transaction(() => {
      for (const m of pending) {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      }
    });
    apply();
  }
  return { db, applied: pending.map((m) => m.version), backup };
}

function pruneBackups(dir: string, keep: number): void {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort();
  while (files.length > keep) {
    const oldest = files.shift()!;
    fs.rmSync(path.join(dir, oldest), { force: true });
  }
}
