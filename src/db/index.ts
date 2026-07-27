/**
 * Database access. SQLite via `node:sqlite` keeps the repository dependency-free;
 * all SQL is confined to this directory so the engine can be swapped for
 * Postgres without touching domain, worker or HTTP code.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, 'migrations');

export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_PATH ?? join(process.cwd(), 'data', 'housemanagement.db');
}

export function openDatabase(path: string = defaultDatabasePath()): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

function ensureMigrationTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.up.sql'))
    .map((f) => f.replace(/\.up\.sql$/, ''))
    .sort();
}

/** Applies pending migrations. Safe to re-run; each migration is applied once. */
export function migrateUp(db: Db): string[] {
  ensureMigrationTable(db);
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migration').all() as { name: string }[]).map((r) => r.name),
  );
  const ran: string[] = [];
  for (const name of migrationNames()) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, `${name}.up.sql`), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)').run(
        name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    ran.push(name);
  }
  return ran;
}

/** Rolls back the most recently applied migration. */
export function migrateDown(db: Db): string | null {
  ensureMigrationTable(db);
  const last = db
    .prepare('SELECT name FROM schema_migration ORDER BY name DESC LIMIT 1')
    .get() as { name: string } | undefined;
  if (!last) return null;

  const sql = readFileSync(join(MIGRATIONS_DIR, `${last.name}.down.sql`), 'utf8');
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.prepare('DELETE FROM schema_migration WHERE name = ?').run(last.name);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return last.name;
}

/** Fresh in-memory database with the schema applied — used by tests. */
export function openTestDatabase(): Db {
  const db = openDatabase(':memory:');
  migrateUp(db);
  return db;
}
