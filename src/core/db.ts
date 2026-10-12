import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations } from "./migrations.js";
export function openDatabase(
  path = process.env.CONTACTS_DB ?? "./data/contacts.db",
): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)",
  );
  migrations.forEach((sql, index) => {
    db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(index + 1)) {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?)").run(index + 1);
      }
    }).immediate();
  });
  return db;
}
