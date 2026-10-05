import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export type DB = DatabaseSync;

/** Open (and migrate) the database. Use ":memory:" for tests. */
export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  // schema.sql is idempotent (CREATE IF NOT EXISTS). Future column changes go in numbered steps below.
  const sqlPath = [join(here, "schema.sql"), join(here, "../../src/db/schema.sql")].find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!sqlPath) throw new Error("schema.sql not found");
  db.exec(readFileSync(sqlPath, "utf8"));
  const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
  if (!applied) {
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  }
}

/** Run fn inside a transaction (BEGIN IMMEDIATE takes the write lock up front). */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
