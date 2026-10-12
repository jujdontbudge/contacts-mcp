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
      "INSERT INTO send_rules VALUES (?,?,?,?,?,?,?)",
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
