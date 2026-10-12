import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContactsCore } from "../src/core/index.js";
import Database from "better-sqlite3";
import { migrations } from "../src/core/migrations.js";
it("persists data in WAL mode, runs migrations once, and enforces uniqueness", () => {
  const dir = mkdtempSync(join(tmpdir(), "contacts-mcp-test-"));
  const path = join(dir, "nested", "contacts.db");
  let core: ContactsCore | undefined;
  try {
    core = new ContactsCore({ path });
    expect(core.store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    const person = core.identity.create({ display_name: "Persisted" });
    const handle = core.handles.add({
      channel: "email",
      value: "a@example.com",
      person_id: person.id,
      actor: "owner",
      reason: "Confirmed",
    });
    expect(
      core.handles.add({
        channel: "email",
        value: "A@example.com",
        actor: "owner",
        reason: "Duplicate",
      }).id,
    ).toBe(handle.id);
    expect(() =>
      core!.store.run(
        "INSERT INTO handles VALUES (?,?,?,?,?,?,?)",
        "duplicate",
        "email",
        "a@example.com",
        "A@example.com",
        null,
        "default",
        core!.store.now(),
      ),
    ).toThrow("UNIQUE");
    core.close();
    core = new ContactsCore({ path });
    expect(core.identity.get(person.id).display_name).toBe("Persisted");
    expect(core.store.all("SELECT * FROM schema_migrations")).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
    expect(core.store.all("SELECT * FROM handle_events")).toHaveLength(1);
  } finally {
    core?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("upgrades a version-4 database without losing rules and persists removal audit across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "contacts-upgrade-")), path = join(dir, "legacy.db");
  let core: ContactsCore | undefined;
  try {
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)");
    migrations.slice(0, 4).forEach((sql, index) => { legacy.exec(sql); legacy.prepare("INSERT INTO schema_migrations VALUES (?)").run(index + 1); });
    legacy.prepare("INSERT INTO send_rules VALUES (?,?,?,?,?,?,?)").run("sr_legacy", "tag", "creator", '["email"]', "owner", "2026-10-12T12:00:00Z", 1);
    legacy.close();
    core = new ContactsCore({ path });
    expect(core.authorization.list()[0]).toMatchObject({ id: "sr_legacy", active: 1, removed_by: null, removed_at: null });
    const removed = core.authorization.remove("sr_legacy", "owner");
    core.close();
    core = new ContactsCore({ path });
    expect(core.authorization.list()[0]).toEqual(removed);
    expect(core.store.all("SELECT * FROM sync_leases")).toEqual([]);
  } finally { core?.close(); rmSync(dir, { recursive: true, force: true }); }
});
