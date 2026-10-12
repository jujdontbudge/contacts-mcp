import { Store } from "./store.js";
import type { Handle, Person } from "./types.js";
export class Identity {
  constructor(private s: Store) {}
  create(input: {
    display_name: string;
    aliases?: string[];
    tags?: string[];
    notes?: string;
    links?: { system: string; external_id: string }[];
  }): Person {
    const id = this.s.id("p");
    const now = this.s.now();
    this.s.db.transaction(() => {
      this.s.run(
        "INSERT INTO persons VALUES (?,?,?,?,?,?,?)",
        id,
        input.display_name,
        JSON.stringify(input.aliases ?? []),
        JSON.stringify(input.tags ?? []),
        input.notes ?? "",
        now,
        now,
      );
      this.links(id, input.links ?? []);
    })();
    return this.get(id);
  }
  update(
    id: string,
    input: {
      display_name?: string;
      aliases?: string[];
      tags?: string[];
      notes?: string;
      links?: { system: string; external_id: string }[];
    },
  ): Person {
    const p = this.get(id);
    this.s.db.transaction(() => {
      this.s.run(
        "UPDATE persons SET display_name=?,aliases=?,tags=?,notes=?,updated_at=? WHERE id=?",
        input.display_name ?? p.display_name,
        JSON.stringify(input.aliases ?? p.aliases),
        JSON.stringify(input.tags ?? p.tags),
        input.notes ?? p.notes,
        this.s.now(),
        id,
      );
      this.links(id, input.links ?? []);
    })();
    return this.get(id);
  }
  private links(
    id: string,
    links: { system: string; external_id: string }[],
  ): void {
    for (const l of links) {
      const old = this.s.one<{ person_id: string }>(
        "SELECT person_id FROM person_links WHERE system=? AND external_id=?",
        l.system,
        l.external_id,
      );
      if (old && old.person_id !== id)
        throw new Error("External link already belongs to another person");
      this.s.run(
        "INSERT OR IGNORE INTO person_links VALUES (?,?,?)",
        id,
        l.system,
        l.external_id,
      );
    }
  }
  get(id: string): Person {
    const p = this.s.one<Person>("SELECT * FROM persons WHERE id=?", id);
    if (!p) throw new Error("Person not found");
    return p;
  }
  list(): Person[] {
    return this.s.all<Person>("SELECT * FROM persons ORDER BY display_name");
  }
  detail(id: string) {
    return {
      ...this.get(id),
      handles: this.s.all<Handle>(
        "SELECT * FROM handles WHERE person_id=?",
        id,
      ),
      links: this.s.all<{ system: string; external_id: string }>(
        "SELECT system,external_id FROM person_links WHERE person_id=?",
        id,
      ),
    };
  }
}
