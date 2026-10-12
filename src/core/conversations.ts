import type { ChannelId, IngestEvent } from "../channels/channel.js";
import type { Conversation, Message } from "./types.js";
import { Store } from "./store.js";
import { Handles } from "./handles.js";
export class Conversations {
  constructor(
    private s: Store,
    private handles: Handles,
  ) {}
  ingest(event: IngestEvent): Message {
    if (!Number.isFinite(Date.parse(event.sent_at)))
      throw new Error("Invalid sent_at");
    return this.s.db.transaction(() => {
      const sender = this.handles.ensure(
        event.channel,
        event.account_id,
        event.sender,
      );
      const conversation = this.upsert(
        event.channel,
        event.account_id,
        event.conversation_external_id,
        event.kind ?? "direct",
        event.title,
      );
      for (const h of [
        sender,
        ...(event.participants ?? []).map((p) =>
          this.handles.ensure(event.channel, event.account_id, p),
        ),
      ])
        this.s.run(
          "INSERT OR IGNORE INTO conversation_participants VALUES (?,?)",
          conversation.id,
          h.id,
        );
      const existing = this.s.one<Message>(
        "SELECT * FROM messages WHERE channel=? AND external_id=?",
        event.channel,
        event.external_id,
      );
      if (existing) {
        // Replace the locally recorded outgoing copy with canonical sync metadata.
        if (existing.direction !== event.direction)
          throw new Error("External message ID has conflicting direction");
        if (existing.conversation_id !== conversation.id) {
          this.s.run(
            "INSERT OR IGNORE INTO conversation_participants SELECT ?,handle_id FROM conversation_participants WHERE conversation_id=?",
            conversation.id,
            existing.conversation_id,
          );
          this.s.run(
            "UPDATE outbox SET conversation_id=? WHERE sent_message_id=?",
            conversation.id,
            existing.id,
          );
        }
        this.s.run(
          "UPDATE messages SET conversation_id=?,sender_handle_id=?,sent_at=?,text=?,subject=?,email_to=?,email_cc=?,email_bcc=?,attachments=?,reply_to_external_id=?,raw=? WHERE id=?",
          conversation.id,
          sender.id,
          new Date(event.sent_at).toISOString(),
          event.text,
          event.subject ?? null,
          JSON.stringify(event.email_to ?? []),
          JSON.stringify(event.email_cc ?? []),
          JSON.stringify(event.email_bcc ?? []),
          JSON.stringify(event.attachments ?? []),
          event.reply_to_external_id ?? null,
          JSON.stringify(event.raw ?? {}),
          existing.id,
        );
        return this.s.one<Message>(
          "SELECT * FROM messages WHERE id=?",
          existing.id,
        )!;
      }
      const id = this.s.id("m");
      this.s.run(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        conversation.id,
        event.channel,
        event.external_id,
        event.direction,
        sender.id,
        new Date(event.sent_at).toISOString(),
        event.text,
        event.subject ?? null,
        JSON.stringify(event.email_to ?? []),
        JSON.stringify(event.email_cc ?? []),
        JSON.stringify(event.email_bcc ?? []),
        JSON.stringify(event.attachments ?? []),
        event.reply_to_external_id ?? null,
        JSON.stringify(event.raw ?? {}),
        this.s.now(),
      );
      return this.s.one<Message>("SELECT * FROM messages WHERE id=?", id)!;
    })();
  }
  lookupEvent(channel: ChannelId, id: string): IngestEvent | undefined {
    const matches = this.s.all<Message>(
      `SELECT * FROM messages WHERE channel=? AND (external_id=? OR json_extract(raw,'$.message_id')=? OR EXISTS (SELECT 1 FROM json_each(raw,'$.headers') WHERE lower(key)='message-id' AND value=?))`,
      channel,
      id,
      id,
      id,
    );
    if (matches.length > 1) throw new Error("Stored Message-ID is ambiguous");
    const message = matches[0];
    if (!message?.sender_handle_id) return undefined;
    const conversation = this.get(message.conversation_id);
    const participants = this.s.all<{ value_raw: string }>(
      "SELECT h.value_raw FROM handles h JOIN conversation_participants cp ON cp.handle_id=h.id WHERE cp.conversation_id=?",
      conversation.id,
    );
    return {
      ...message,
      account_id: conversation.account_id,
      conversation_external_id: conversation.external_id,
      kind: conversation.kind,
      title: conversation.title ?? undefined,
      sender: this.handles.get(message.sender_handle_id).value_raw,
      participants: participants.map((h) => h.value_raw),
    };
  }
  upsert(
    channel: ChannelId,
    account: string,
    external: string,
    kind: "direct" | "group",
    title?: string,
  ): Conversation {
    this.s.run(
      "INSERT INTO conversations VALUES (?,?,?,?,?,?) ON CONFLICT(channel,account_id,external_id) DO UPDATE SET kind=excluded.kind,title=COALESCE(excluded.title,conversations.title)",
      this.s.id("c"),
      channel,
      account,
      external,
      kind,
      title ?? null,
    );
    return this.s.one<Conversation>(
      "SELECT * FROM conversations WHERE channel=? AND account_id=? AND external_id=?",
      channel,
      account,
      external,
    )!;
  }
  get(id: string): Conversation {
    const c = this.s.one<Conversation>(
      "SELECT * FROM conversations WHERE id=?",
      id,
    );
    if (!c) throw new Error("Conversation not found");
    return c;
  }
  detail(id: string) {
    return {
      ...this.get(id),
      participants: this.s.all(
        "SELECT h.* FROM handles h JOIN conversation_participants cp ON cp.handle_id=h.id WHERE cp.conversation_id=?",
        id,
      ),
      messages: this.s.all<Message>(
        "SELECT * FROM messages WHERE conversation_id=? ORDER BY sent_at,id",
        id,
      ),
    };
  }
  list(person_id?: string, channel?: ChannelId): Conversation[] {
    return this.s.all<Conversation>(
      `SELECT c.* FROM conversations c WHERE (? IS NULL OR c.channel=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM conversation_participants cp JOIN handles h ON h.id=cp.handle_id WHERE cp.conversation_id=c.id AND h.person_id=?)) ORDER BY (SELECT MAX(sent_at) FROM messages WHERE conversation_id=c.id) DESC,c.rowid DESC`,
      channel ?? null,
      channel ?? null,
      person_id ?? null,
      person_id ?? null,
    );
  }
  timeline(person_id: string, limit = 100): Message[] {
    return this.s.all<Message>(
      "SELECT m.* FROM messages m WHERE EXISTS (SELECT 1 FROM conversation_participants cp JOIN handles h ON h.id=cp.handle_id WHERE cp.conversation_id=m.conversation_id AND h.person_id=?) ORDER BY m.sent_at DESC,m.id DESC LIMIT ?",
      person_id,
      limit,
    );
  }
  search(
    query: string,
    person_id?: string,
    channel?: ChannelId,
    limit = 100,
  ): Message[] {
    return this.s.all<Message>(
      `SELECT m.* FROM messages m WHERE (instr(lower(m.text),lower(?))>0 OR instr(lower(COALESCE(m.subject,'')),lower(?))>0) AND (? IS NULL OR m.channel=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM conversation_participants cp JOIN handles h ON h.id=cp.handle_id WHERE cp.conversation_id=m.conversation_id AND h.person_id=?)) ORDER BY sent_at DESC LIMIT ?`,
      query,
      query,
      channel ?? null,
      channel ?? null,
      person_id ?? null,
      person_id ?? null,
      limit,
    );
  }
}
