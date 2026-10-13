import { Store } from "./store.js";
import type { ChannelId } from "../channels/channel.js";
import type { Handle, Message, Person } from "./types.js";

export type InboxOutcome = "new" | "claimed" | "auto_replied" | "escalated" | "ignored" | "done";
export interface InboxState {
  message_id: string;
  outcome: InboxOutcome;
  actor: string;
  note: string;
  rule: string | null;
  outbox_id: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
  created_at: string;
  updated_at: string;
}
export class Inbox {
  constructor(private s: Store) {}
  config() {
    return this.s.one<{ cutoff: string; actor: string; updated_at: string }>("SELECT cutoff,actor,updated_at FROM inbox_config WHERE id=1") ?? null;
  }
  setCutoff(cutoff: string, actor: string) {
    if (!Number.isFinite(Date.parse(cutoff)) || !actor.trim()) throw new Error("Cutoff requires an ISO timestamp and actor");
    return this.s.db.transaction(() => {
      const at = this.s.now();
      const normalized = new Date(cutoff).toISOString();
      this.s.run("INSERT INTO inbox_config VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET cutoff=excluded.cutoff,actor=excluded.actor,updated_at=excluded.updated_at", normalized, actor, at);
      this.s.run("INSERT INTO inbox_events(id,outcome,actor,note,at) VALUES (?,?,?,?,?)", this.s.id("ie"), "cutoff", actor, normalized, at);
      return this.config();
    }).immediate();
  }
  private state(messageId: string): InboxState | undefined {
    return this.s.one("SELECT * FROM inbox_handling WHERE message_id=?", messageId);
  }
  private write(messageId: string, outcome: InboxOutcome, actor: string, note: string, rule: string | null = null, outboxId: string | null = null, token: string | null = null, expiry: string | null = null) {
    const at = this.s.now();
    this.s.run("INSERT INTO inbox_handling VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET outcome=excluded.outcome,actor=excluded.actor,note=excluded.note,rule=excluded.rule,outbox_id=excluded.outbox_id,claim_token=excluded.claim_token,claim_expires_at=excluded.claim_expires_at,updated_at=excluded.updated_at", messageId, outcome, actor, note, rule, outboxId, token, expiry, at, at);
    this.s.run("INSERT INTO inbox_events VALUES (?,?,?,?,?,?,?,?,?,?)", this.s.id("ie"), messageId, outcome, actor, note, rule, outboxId, token, expiry, at);
    return this.state(messageId)!;
  }
  /** A confirmed outgoing message closes all earlier pending inbound messages. */
  private settleAnswered() {
    const cutoff = this.config()?.cutoff;
    if (!cutoff) return;
    const rows = this.s.all<{ id: string }>(`SELECT m.id FROM messages m LEFT JOIN inbox_handling h ON h.message_id=m.id
      WHERE m.direction='in' AND julianday(m.sent_at)>julianday(?) AND (h.outcome IS NULL OR h.outcome IN ('new','claimed'))
      AND EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id=m.conversation_id AND o.direction='out' AND julianday(o.sent_at)>julianday(m.sent_at)
      AND (json_extract(o.raw,'$.message.sendStatus.status') IS NULL OR json_extract(o.raw,'$.message.sendStatus.status')='SUCCESS'))`, cutoff);
    for (const row of rows) {
      const reply = this.s.one<{ id: string }>("SELECT id FROM outbox WHERE inbox_message_id=? AND status='sent'", row.id);
      const old = this.state(row.id);
      this.write(row.id, reply ? "auto_replied" : "done", "reply-reconciliation", "Confirmed outgoing message after inbound in this conversation", null, reply?.id ?? null, old?.claim_token ?? null, old?.claim_expires_at ?? null);
    }
  }
  list(input: { channels?: ChannelId[]; limit?: number } = {}) {
    const channels = input.channels ?? ["email", "instagram", "tiktok"];
    const limit = input.limit ?? 100;
    if (!channels.length || channels.some(c => !["email", "instagram", "tiktok", "imessage"].includes(c)) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid inbox channels or limit");
    return this.s.db.transaction(() => {
      this.settleAnswered();
      const config = this.config();
      if (!config) return { cutoff: null, items: [] }; // Disabled until deliberately activated.
      const messages = this.s.all<Message>(`SELECT m.* FROM messages m LEFT JOIN inbox_handling h ON h.message_id=m.id WHERE m.direction='in' AND julianday(m.sent_at)>julianday(?) AND m.channel IN (${channels.map(() => "?").join(",")}) AND (h.outcome IS NULL OR h.outcome='new' OR (h.outcome='claimed' AND h.claim_expires_at<=?)) ORDER BY m.sent_at,m.id LIMIT ?`, config.cutoff, ...channels, this.s.now(), limit);
      return { cutoff: config.cutoff, items: messages.map(m => {
        const handle = m.sender_handle_id ? this.s.one<Handle>("SELECT * FROM handles WHERE id=?", m.sender_handle_id) ?? null : null;
        const p = handle?.person_id ? this.s.one<Person>("SELECT * FROM persons WHERE id=?", handle.person_id) : null;
        if (!this.state(m.id)) this.write(m.id, "new", "inbox", "Inbound eligible after go-live cutoff");
        const { raw: _raw, ...message } = m;
        const context = this.s.all<Message>("SELECT * FROM messages WHERE conversation_id=? ORDER BY sent_at DESC,rowid DESC LIMIT 5", m.conversation_id).reverse().map(({ raw: _raw, ...item }) => item);
        return { ...message, person: p ? { id: p.id, name: p.display_name, tags: p.tags } : null, handle, context, state: this.state(m.id) ?? { message_id: m.id, outcome: "new" } };
      }) };
    }).immediate();
  }
  claim(input: { message_ids: string[]; actor: string; lease_seconds?: number }) {
    const seconds = input.lease_seconds ?? 600;
    if (!input.actor.trim() || !input.message_ids.length || input.message_ids.length > 1000 || new Set(input.message_ids).size !== input.message_ids.length || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("Invalid claim actor, ids or lease");
    return this.s.db.transaction(() => {
      this.settleAnswered();
      for (const id of input.message_ids) {
        const m = this.s.one<Message>("SELECT * FROM messages WHERE id=?", id);
        const state = this.state(id);
        const cutoff = this.config()?.cutoff;
        if (!m || m.direction !== "in" || !cutoff || Date.parse(m.sent_at) <= Date.parse(cutoff) || (state && state.outcome !== "new" && !(state.outcome === "claimed" && state.claim_expires_at! <= this.s.now()))) throw new Error(`Message unavailable: ${id}`);
      }
      const token = this.s.id("claim");
      const expiry = new Date(this.s.clock().getTime() + seconds * 1000).toISOString();
      return { claim_token: token, claim_expires_at: expiry, items: input.message_ids.map(id => this.write(id, "claimed", input.actor, "Inbox lease acquired", null, null, token, expiry)) };
    }).immediate();
  }
  assertClaim(messageId: string, token: string | undefined, conversationId?: string) {
    this.settleAnswered();
    const state = this.state(messageId);
    if (!token || state?.outcome !== "claimed" || state.claim_token !== token || state.claim_expires_at! <= this.s.now()) throw new Error("Inbox claim is missing, expired or superseded");
    if (conversationId && !this.s.one("SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND direction='in'", messageId, conversationId)) throw new Error("Inbox reply must use the inbound conversation");
    return state;
  }
  mark(input: { message_id: string; outcome: Exclude<InboxOutcome, "new" | "claimed">; actor: string; note: string; claim_token: string; rule?: string; outbox_id?: string }) {
    if (!input.actor.trim() || !input.note.trim() || !["auto_replied", "escalated", "ignored", "done"].includes(input.outcome)) throw new Error("Invalid final outcome, actor or note");
    return this.s.db.transaction(() => {
      const old = this.state(input.message_id);
      if (old?.outcome === input.outcome && old.actor === input.actor && old.note === input.note && old.rule === (input.rule ?? null) && old.outbox_id === (input.outbox_id ?? null)) return old;
      this.settleAnswered();
      const settled = this.state(input.message_id);
      if (!(settled?.outcome === "auto_replied" && settled.outbox_id === input.outbox_id && settled.claim_token === input.claim_token)) this.assertClaim(input.message_id, input.claim_token);
      if (input.outbox_id && !this.s.one("SELECT 1 FROM outbox WHERE id=? AND inbox_message_id=?", input.outbox_id, input.message_id)) throw new Error("Outbox is not bound to this inbound message");
      if (input.outcome === "auto_replied" && !this.s.one("SELECT 1 FROM outbox WHERE id=? AND inbox_message_id=? AND status='sent'", input.outbox_id ?? null, input.message_id)) throw new Error("auto_replied requires a confirmed bound send");
      return this.write(input.message_id, input.outcome, input.actor, input.note, input.rule ?? null, input.outbox_id ?? null);
    }).immediate();
  }
}
