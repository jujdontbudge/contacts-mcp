import {
  emailAddress,
  emailHeader,
  emailMessageIds,
  emailRfcId,
  emailSubject,
} from "./email-threading.js";
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
        (event.channel === "email"
          ? this.emailThread(event)?.external_id
          : undefined) ?? event.conversation_external_id,
        event.kind ?? "direct",
        event.title,
      );
      // On outgoing messages the sender is our own account, never a participant
      // we could message; adding it would make every chat look like a chat with us.
      for (const h of [
        ...(event.direction === "out" ? [] : [sender]),
        ...(event.participants ?? []).map((p) =>
          this.handles.ensure(event.channel, event.account_id, p),
        ),
      ])
        this.s.run(
          "INSERT OR IGNORE INTO conversation_participants VALUES (?,?)",
          conversation.id,
          h.id,
        );
      // Adapter-proven aliases also remove pollution left by older versions.
      // Preserve a deliberate self-chat: cleanup needs at least one external peer.
      if (event.own_handles?.length) {
        const own = event.own_handles.map(value => this.handles.ensure(event.channel, event.account_id, value));
        const ownIds = new Set(own.map(handle => handle.id));
        const participants = this.s.all<{ handle_id: string }>("SELECT handle_id FROM conversation_participants WHERE conversation_id=?", conversation.id);
        if (participants.some(participant => !ownIds.has(participant.handle_id)))
          for (const handle of own) this.s.run("DELETE FROM conversation_participants WHERE conversation_id=? AND handle_id=?", conversation.id, handle.id);
      }
      const existing = this.s.one<Message>(
        "SELECT * FROM messages WHERE channel=? AND external_id=?",
        event.channel,
        event.external_id,
      );
      if (existing) {
        const original = this.get(existing.conversation_id);
        if (original.account_id !== event.account_id)
          throw new Error("External message ID has conflicting account");
        const proof = (existing.raw as { contacts_platform_message_id?: string } | null)?.contacts_platform_message_id ??
          (event.raw as { contacts_platform_message_id?: string } | null)?.contacts_platform_message_id;
        const provenPlatformMove = event.channel === "instagram" && proof && event.external_id.startsWith("ig:") && event.external_id.endsWith(`:message:${encodeURIComponent(proof)}`);
        if (existing.conversation_id !== conversation.id && event.channel !== "email" && !provenPlatformMove &&
            (existing.raw as { source?: string } | null)?.source !== "outbox")
          throw new Error("External message ID has conflicting conversation");
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
  /** Match RFC ancestry first; subject fallback requires the same exact counterpart set. */
  private emailThread(
    event: IngestEvent,
    excludeConversation?: string,
  ): Conversation | undefined {
    const rows = this.s.all<
      Message & { account_id: string; sender: string | null; sequence: number }
    >(
      "SELECT m.*,m.rowid AS sequence,c.account_id,h.value_normalized AS sender FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN handles h ON h.id=m.sender_handle_id WHERE m.channel='email' AND c.account_id=? AND m.external_id<>? ORDER BY m.sent_at,m.rowid",
      event.account_id,
      event.external_id,
    );
    const ancestors = [
      ...new Set(
        [
          event.reply_to_external_id,
          ...emailMessageIds(emailHeader(event.raw, "In-Reply-To")),
          ...emailMessageIds(emailHeader(event.raw, "References")).reverse(),
        ].filter((id): id is string => !!id),
      ),
    ];
    for (const id of ancestors) {
      const matches = rows.filter(
        (m) => m.external_id === id || emailRfcId(m.raw) === id,
      );
      const conversations = new Set(matches.map((m) => m.conversation_id));
      if (conversations.size > 1)
        throw new Error("Stored email ancestor is ambiguous");
      if (matches.length && matches[0].conversation_id !== excludeConversation)
        return this.get(matches[0].conversation_id);
    }
    const counterpart = (
      direction: string,
      sender: string | null,
      to: string[] = [],
      cc: string[] = [],
      bcc: string[] = [],
    ) => {
      // Direct replies may arrive at a forwarding/reply-to alias. Match the other person,
      // not our receiving address. For group outreach retain the complete recipient set.
      const values =
        direction === "in"
          ? sender
            ? [sender, ...cc]
            : []
          : [...to, ...cc, ...bcc];
      return JSON.stringify([...new Set(values.map(emailAddress))].sort());
    };
    const key = counterpart(
      event.direction,
      event.sender,
      event.email_to,
      event.email_cc,
      event.email_bcc,
    );
    const subject = emailSubject(event.subject ?? "");
    if (!subject || key === "[]") return undefined;
    const sequence = this.s.one<{ sequence: number }>(
      "SELECT rowid AS sequence FROM messages WHERE channel='email' AND external_id=?",
      event.external_id,
    )?.sequence;
    const candidates = rows.filter(
      (m) =>
        m.conversation_id !== excludeConversation &&
        (Date.parse(m.sent_at) < Date.parse(event.sent_at) ||
          (Date.parse(m.sent_at) === Date.parse(event.sent_at) &&
            (sequence === undefined || m.sequence < sequence))) &&
        emailSubject(m.subject ?? "") === subject &&
        counterpart(
          m.direction,
          m.sender,
          m.email_to,
          m.email_cc,
          m.email_bcc,
        ) === key,
    );
    const conversations = new Set(candidates.map((m) => m.conversation_id));
    return conversations.size === 1
      ? this.get(candidates[0].conversation_id)
      : undefined;
  }
  missingEmailMessageIds(account: string): string[] {
    return this.s
      .all<Message>(
        "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.channel='email' AND m.direction='out' AND c.account_id=?",
        account,
      )
      .filter((m) => !emailRfcId(m.raw))
      .map((m) => m.external_id);
  }
  updateEmailMetadata(
    account: string,
    id: string,
    detail: {
      id?: string;
      message_id?: string | null;
      headers?: Record<string, string>;
    },
  ): void {
    if (detail.id !== id) throw new Error("Resend sent email ID mismatch");
    this.s.db.transaction(() => {
      const m = this.s.one<Message>(
        "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.channel='email' AND m.direction='out' AND c.account_id=? AND m.external_id=?",
        account,
        id,
      );
      if (!m) throw new Error("Sent email not found");
      const raw = m.raw as Record<string, unknown>;
      const merged = {
        ...raw,
        message_id: detail.message_id ?? (raw.message_id as string | undefined),
        headers: { ...((raw.headers as object) ?? {}), ...detail.headers },
      };
      this.s.run(
        "UPDATE messages SET raw=? WHERE id=?",
        JSON.stringify(merged),
        m.id,
      );
    })();
  }
  /** Offline, transactional and repeatable; never sends or deletes message history. */
  repairEmailThreads(): { merged: number } {
    return this.s.db.transaction(() => {
      let merged = 0;
      const messages = this.s.all<{ external_id: string }>(
        "SELECT external_id FROM messages WHERE channel='email' ORDER BY sent_at,rowid",
      );
      for (const message of messages) {
        const event = this.lookupEvent("email", message.external_id);
        if (!event) continue;
        const source = this.s.one<Message>(
          "SELECT * FROM messages WHERE channel='email' AND external_id=?",
          message.external_id,
        )!;
        const target = this.emailThread(event, source.conversation_id);
        if (!target) continue;
        const original = this.get(source.conversation_id);
        this.s.run(
          "INSERT OR IGNORE INTO conversation_participants SELECT ?,handle_id FROM conversation_participants WHERE conversation_id=?",
          target.id,
          original.id,
        );
        this.s.run(
          "UPDATE messages SET conversation_id=? WHERE conversation_id=?",
          target.id,
          original.id,
        );
        this.s.run(
          "UPDATE outbox SET conversation_id=? WHERE conversation_id=?",
          target.id,
          original.id,
        );
        this.s.run(
          "UPDATE staged_outgoing SET payload=json_set(payload,'$.conversation_external_id',?) WHERE json_extract(payload,'$.channel')='email' AND json_extract(payload,'$.account_id')=? AND json_extract(payload,'$.conversation_external_id')=?",
          target.external_id,
          original.account_id,
          original.external_id,
        );
        this.s.run(
          "DELETE FROM conversation_participants WHERE conversation_id=?",
          original.id,
        );
        this.s.run("DELETE FROM conversations WHERE id=?", original.id);
        merged++;
      }
      return { merged };
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
      "INSERT INTO conversations VALUES (?,?,?,?,?,?) ON CONFLICT(channel,account_id,external_id) DO UPDATE SET kind=CASE WHEN conversations.kind='group' THEN 'group' ELSE excluded.kind END,title=COALESCE(excluded.title,conversations.title)",
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
  detail(id: string, limit?: number, offset = 0) {
    return {
      ...this.get(id),
      total_messages: this.s.one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?", id)!.count,
      participants: this.s.all(
        "SELECT h.* FROM handles h JOIN conversation_participants cp ON cp.handle_id=h.id WHERE cp.conversation_id=?",
        id,
      ),
      messages: this.s.all<Message>(
        "SELECT m.* FROM messages m WHERE m.id IN (SELECT id FROM messages WHERE conversation_id=? ORDER BY sent_at DESC,rowid DESC LIMIT ? OFFSET ?) ORDER BY m.sent_at,m.rowid",
        id,
        limit ?? -1,
        offset,
      ),
    };
  }
  message(id: string): Message {
    const message = this.s.one<Message>("SELECT * FROM messages WHERE id=?", id);
    if (!message) throw new Error("Message not found");
    return message;
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
