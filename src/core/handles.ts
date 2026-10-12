import { type ChannelId } from "../channels/channel.js";
import { ChannelRegistry } from "../channels/registry.js";
import { Store } from "./store.js";
import { Identity } from "./identity.js";
import type { Handle } from "./types.js";
export class Handles {
  constructor(
    private s: Store,
    private identity: Identity,
    private registry: ChannelRegistry = new ChannelRegistry(),
  ) {}
  get(id: string): Handle {
    const h = this.s.one<Handle>("SELECT * FROM handles WHERE id=?", id);
    if (!h) throw new Error("Handle not found");
    return h;
  }
  add(input: {
    channel: ChannelId;
    value: string;
    person_id?: string;
    account_id?: string;
    actor: string;
    reason: string;
  }): Handle {
    if (input.person_id) this.identity.get(input.person_id);
    const id = this.s.id("h");
    this.s.db.transaction(() => {
      this.s.run(
        "INSERT INTO handles VALUES (?,?,?,?,?,?,?)",
        id,
        input.channel,
        this.registry.normalize(input.channel, input.value),
        input.value,
        input.person_id ?? null,
        input.account_id ?? "default",
        this.s.now(),
      );
      this.log(
        id,
        null,
        input.person_id ?? null,
        "add",
        input.actor,
        input.reason,
      );
    })();
    return this.get(id);
  }
  change(
    id: string,
    input: {
      value?: string;
      person_id?: string | null;
      actor: string;
      reason: string;
    },
    action: "change" | "link" | "unlink" = "change",
  ): Handle {
    const h = this.get(id);
    const person =
      input.person_id === undefined ? h.person_id : input.person_id;
    if (person) this.identity.get(person);
    this.s.db.transaction(() => {
      this.s.run(
        "UPDATE handles SET value_raw=?,value_normalized=?,person_id=? WHERE id=?",
        input.value ?? h.value_raw,
        this.registry.normalize(h.channel, input.value ?? h.value_raw),
        person,
        id,
      );
      this.log(
        id,
        h.person_id,
        person,
        action,
        input.actor,
        input.value === undefined
          ? input.reason
          : `${input.reason}; value before: ${h.value_raw}; value after: ${input.value}`,
      );
    })();
    return this.get(id);
  }
  link(
    id: string,
    person_id: string,
    actor: string,
    reason: string,
    exact_proof: string,
  ): Handle {
    if (!exact_proof.trim())
      throw new Error(
        "Exact proof is required; fuzzy evidence is only a suggestion",
      );
    return this.change(
      id,
      { person_id, actor, reason: `${reason}; exact proof: ${exact_proof}` },
      "link",
    );
  }
  unlink(id: string, actor: string, reason: string): Handle {
    return this.change(id, { person_id: null, actor, reason }, "unlink");
  }
  unlinked(): Handle[] {
    return this.s.all("SELECT * FROM handles WHERE person_id IS NULL");
  }
  suggest(
    handle_id: string,
    person_id: string,
    evidence: string,
    score: number,
  ): void {
    this.s.run(
      "INSERT INTO link_suggestions VALUES (?,?,?,?,'pending') ON CONFLICT(handle_id,person_id) DO UPDATE SET evidence=excluded.evidence,score=excluded.score",
      handle_id,
      person_id,
      evidence,
      score,
    );
  }
  suggestions() {
    return this.s.all("SELECT * FROM link_suggestions");
  }
  ensure(channel: ChannelId, account_id: string, value: string): Handle {
    return (
      this.s.one<Handle>(
        "SELECT * FROM handles WHERE channel=? AND account_id=? AND value_normalized=?",
        channel,
        account_id,
        this.registry.normalize(channel, value),
      ) ??
      this.add({
        channel,
        account_id,
        value,
        actor: "ingest",
        reason: "Unknown participant",
      })
    );
  }
  events(id: string) {
    return this.s.all(
      "SELECT * FROM handle_events WHERE handle_id=? ORDER BY at,rowid",
      id,
    );
  }
  private log(
    id: string,
    before: string | null,
    after: string | null,
    action: string,
    actor: string,
    reason: string,
  ): void {
    this.s.run(
      "INSERT INTO handle_events VALUES (?,?,?,?,?,?,?,?)",
      this.s.id("he"),
      id,
      before,
      after,
      action,
      actor,
      reason,
      this.s.now(),
    );
  }
}
