import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContactsCore } from "../src/core/index.js";
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
    ]);
    expect(core.store.all("SELECT * FROM handle_events")).toHaveLength(1);
  } finally {
    core?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
