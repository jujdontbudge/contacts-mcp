import type { ChannelId, SendContent } from "../channels/channel.js";
import type { Person, SendRule } from "./types.js";
import { Store } from "./store.js";
export class Authorization {
  constructor(private s: Store) {}
  add(input: {
    scope: SendRule["scope"];
    value: string;
    channels: ChannelId[];
    created_by: string;
  }): SendRule {
    const id = this.s.id("sr");
    this.s.run(
      "INSERT INTO send_rules (id,scope,value,channels,created_by,created_at,active) VALUES (?,?,?,?,?,?,?)",
      id,
      input.scope,
      input.value,
      JSON.stringify(input.channels),
      input.created_by,
      this.s.now(),
      1,
    );
    return this.list().find((r) => r.id === id)!;
  }
  list(): SendRule[] {
    return this.s.all("SELECT * FROM send_rules ORDER BY created_at,id");
  }
  remove(id: string, actor: string): SendRule {
    if (!actor.trim()) throw new Error("Rule removal requires an actor");
    return this.s.db.transaction(() => {
      if (!this.s.one("SELECT 1 FROM send_rules WHERE id=?", id))
        throw new Error("Send rule not found");
      this.s.run(
        "UPDATE send_rules SET active=0,removed_by=?,removed_at=? WHERE id=? AND active=1",
        actor, this.s.now(), id,
      );
      return this.s.one<SendRule>("SELECT * FROM send_rules WHERE id=?", id)!;
    }).immediate();
  }
  match(
    person: Person,
    channel: ChannelId,
    content: SendContent,
  ): SendRule | undefined {
    return this.list().find(
      (r) =>
        r.active &&
        r.channels.includes(channel) &&
        (r.scope === "person"
          ? r.value === person.id
          : r.scope === "tag"
            ? person.tags.includes(r.value)
            : r.value === content.kind),
    );
  }
}
