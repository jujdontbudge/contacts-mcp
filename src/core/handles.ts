import { type ChannelId, type HandleProfile } from "../channels/channel.js";
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
    const existing = this.s.one<Handle>(
      "SELECT * FROM handles WHERE channel=? AND account_id=? AND value_normalized=?",
      input.channel,
      input.account_id ?? "default",
      this.registry.normalize(input.channel, input.value),
    );
    if (existing) {
      if (!input.person_id || existing.person_id === input.person_id)
        return existing;
      if (existing.person_id)
        throw new Error(
          `Handle belongs to person ${existing.person_id}; use change_handle to reassign it after verifying identity`,
        );
      return this.change(
        existing.id,
        {
          person_id: input.person_id,
          actor: input.actor,
          reason: input.reason,
        },
        "link",
      );
    }
    const id = this.s.id("h");
    this.s.db.transaction(() => {
      this.s.run(
        "INSERT INTO handles(id,channel,value_normalized,value_raw,person_id,account_id,created_at) VALUES (?,?,?,?,?,?,?)",
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
    exact_proof: string | true,
  ): Handle {
    if (
      exact_proof !== true &&
      (typeof exact_proof !== "string" || !exact_proof.trim())
    )
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
  /** Exact external links prove identity; public/social similarities remain suggestions. */
  ingestProfile(profile: HandleProfile): Handle {
    return this.s.db.transaction(() => {
      const handle = this.ensure(profile.channel, profile.account_id, profile.value);
      const previous = handle.profile;
      const merged = { ...previous, ...profile,
        job_ids: [...new Set([...(previous?.job_ids ?? []), ...(profile.job_ids ?? [])])],
        related_handles: profile.related_handles?.length ? profile.related_handles : previous?.related_handles ?? [],
      };
      this.s.run("UPDATE handles SET profile=? WHERE id=?", JSON.stringify(merged), handle.id);
      const exact = this.s.one<{ person_id: string }>(
        "SELECT person_id FROM person_links WHERE system=? AND external_id=?", profile.channel, profile.value,
      );
      if (exact && !handle.person_id) this.link(handle.id, exact.person_id, "ingest", "Provider user ID matches stored external link", `${profile.channel}:${profile.value}`);
      // Conflicting proof must never silently reassign an already linked handle.
      if (exact && handle.person_id && exact.person_id !== handle.person_id) throw new Error("Provider identity conflicts with linked handle");
      if (!this.get(handle.id).person_id) {
        for (const related of merged.related_handles) {
          const candidates = this.s.all<{ person_id: string }>("SELECT DISTINCT person_id FROM handles WHERE channel=? AND value_normalized=? AND person_id IS NOT NULL", related.channel, this.registry.normalize(related.channel, related.value));
          for (const candidate of candidates) this.suggest(handle.id, candidate.person_id, `Provider profile lists ${related.channel}:${related.value}; public profile is not exact verified identity proof`, 0.9);
        }
        if (profile.display_name) for (const person of this.identity.list()) {
          if ([person.display_name, ...person.aliases].some(name => name.trim().toLowerCase() === profile.display_name!.trim().toLowerCase()))
            this.suggest(handle.id, person.id, `Provider display name ${profile.display_name}; requires exact proof`, 0.8);
        }
      }
      return this.get(handle.id);
    })();
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
