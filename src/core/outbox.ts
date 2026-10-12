import { ChannelRegistry } from "../channels/registry.js";
import type {
  ChannelId,
  SendContent,
  SendTarget,
} from "../channels/channel.js";
import { Store } from "./store.js";
import { Identity } from "./identity.js";
import { Handles } from "./handles.js";
import { Conversations } from "./conversations.js";
import { Authorization } from "./authorization.js";
import type { Conversation, Handle, Outbox, SendRequest } from "./types.js";
export interface DispatchHooks {
  send?: (
    id: string,
    target: SendTarget,
    content: SendContent,
  ) => Promise<{ externalId: string; conversationExternalId: string }>;
  afterSent?: (id: string) => Promise<void>;
}
export class OutboxService {
  constructor(
    private s: Store,
    private identity: Identity,
    private handles: Handles,
    private conversations: Conversations,
    private auth: Authorization,
    private registry: ChannelRegistry,
    private rates: Partial<Record<ChannelId, number>>,
    private hooks: DispatchHooks = {},
  ) {}
  private resolve(
    input: Pick<
      SendRequest,
      "person_id" | "conversation_id" | "handle_id" | "channel"
    >,
  ): SendTarget {
    let conversation = input.conversation_id
      ? this.conversations.get(input.conversation_id)
      : undefined;
    let personId = input.person_id;
    if (conversation && !personId) {
      const persons = this.s.all<{ person_id: string }>(
        "SELECT DISTINCT h.person_id FROM handles h JOIN conversation_participants cp ON cp.handle_id=h.id WHERE cp.conversation_id=? AND h.person_id IS NOT NULL",
        conversation.id,
      );
      if (persons.length !== 1)
        throw new Error("Conversation target is ambiguous; provide person_id");
      personId = persons[0].person_id;
    }
    if (!personId)
      throw new Error(
        "Provide person_id or conversation_id; names must be resolved first",
      );
    this.identity.get(personId);
    if (conversation && input.channel && input.channel !== conversation.channel)
      throw new Error("Conversation/channel mismatch");
    let explicit = input.handle_id
      ? this.handles.get(input.handle_id)
      : undefined;
    if (explicit && explicit.person_id !== personId)
      throw new Error("Handle does not belong to person");
    let channel = conversation?.channel ?? input.channel ?? explicit?.channel;
    if (!conversation) {
      conversation = this.conversations
        .list(personId, channel)
        .find(
          (c) =>
            !explicit ||
            (c.channel === explicit.channel &&
              c.account_id === explicit.account_id &&
              !!this.s.one(
                "SELECT 1 FROM conversation_participants WHERE conversation_id=? AND handle_id=?",
                c.id,
                explicit.id,
              )),
        );
      channel ??= conversation?.channel;
    }
    if (!channel) {
      const channels = this.s.all<{ channel: ChannelId }>(
        "SELECT DISTINCT channel FROM handles WHERE person_id=?",
        personId,
      );
      if (channels.length !== 1) throw new Error("Choose a channel explicitly");
      channel = channels[0].channel;
    }
    if (explicit && explicit.channel !== channel)
      throw new Error("Handle/channel mismatch");
    const handle =
      explicit ??
      (conversation
        ? this.s.one<Handle>(
            "SELECT h.* FROM handles h JOIN conversation_participants cp ON cp.handle_id=h.id WHERE cp.conversation_id=? AND h.person_id=? ORDER BY h.created_at DESC,h.rowid DESC LIMIT 1",
            conversation.id,
            personId,
          )
        : this.s.one<Handle>(
            "SELECT * FROM handles WHERE person_id=? AND channel=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            personId,
            channel,
          ));
    if (!handle || handle.person_id !== personId)
      throw new Error("No handle belonging to this person on target channel");
    if (
      conversation &&
      (handle.account_id !== conversation.account_id ||
        !this.s.one(
          "SELECT 1 FROM conversation_participants WHERE conversation_id=? AND handle_id=?",
          conversation.id,
          handle.id,
        ))
    )
      throw new Error("Handle is not a participant in this conversation");
    return {
      person_id: personId,
      handle_id: handle.id,
      handle: handle.value_normalized,
      channel,
      account_id: handle.account_id,
      conversation_id: conversation?.id,
      conversationExternalId: conversation?.external_id,
      conversationKind: conversation?.kind,
    };
  }
  private checks(target: SendTarget, content: SendContent, rate = true): void {
    const channel = this.registry.get(target.channel);
    if (this.handles.get(target.handle_id).person_id !== target.person_id)
      throw new Error("Handle no longer belongs to person");
    if (!target.conversation_id && !channel.capabilities.startConversation)
      throw new Error("Channel cannot start a conversation");
    if (target.conversationKind === "group" && !channel.capabilities.groups)
      throw new Error("Channel does not support groups");
    if (
      (content.email_cc?.length || content.email_bcc?.length) &&
      !channel.capabilities.cc
    )
      throw new Error("Channel does not support CC/BCC");
    if (channel.capabilities.replyWindowHours !== undefined) {
      const last = this.s.one<{ sent_at: string }>(
        "SELECT sent_at FROM messages WHERE conversation_id=? AND direction='in' ORDER BY sent_at DESC LIMIT 1",
        target.conversation_id ?? null,
      );
      if (
        !last ||
        this.s.clock().getTime() - Date.parse(last.sent_at) >=
          (target.channel === "instagram" && content.metadata?.instagram_tag === "HUMAN_AGENT"
            ? 168 : channel.capabilities.replyWindowHours) * 3600000
      )
        throw new Error("Reply window is closed");
    }
    const limit = this.rates[target.channel];
    if (rate && limit !== undefined) {
      const since = new Date(this.s.clock().getTime() - 3600000).toISOString();
      const count = this.s.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM outbox WHERE channel=? AND status IN ('sending','sent') AND decided_at>?",
        target.channel,
        since,
      )!.count;
      if (count >= limit) throw new Error("Channel hourly rate limit reached");
    }
  }
  async send(input: SendRequest) {
    const target = this.resolve(input);
    const {
      text,
      subject,
      email_to,
      email_cc,
      email_bcc,
      attachments,
      reply_to_external_id,
      kind,
      metadata,
    } = input;
    const content: SendContent = {
      text,
      subject,
      email_to,
      email_cc,
      email_bcc,
      attachments,
      reply_to_external_id,
      kind,
      metadata,
    };
    if (!text.trim() && !attachments?.length)
      throw new Error("Message must have text or attachments");
    if (input.authorized_by && !input.reason?.trim())
      throw new Error("Direct authorization requires a reason");
    this.checks(target, content);
    const rule = this.auth.match(
      this.identity.get(target.person_id),
      target.channel,
      content,
    );
    const authorized_by =
      input.authorized_by ?? (rule ? rule.created_by : null);
    const reason =
      input.reason ??
      (rule ? `Standing rule ${rule.id} (${rule.scope}:${rule.value})` : null);
    const id = this.s.id("o");
    this.s.run(
      "INSERT INTO outbox (id,status,person_id,conversation_id,handle_id,channel,payload,authorized_by,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      id,
      "draft",
      target.person_id,
      target.conversation_id ?? null,
      target.handle_id,
      target.channel,
      JSON.stringify(content),
      authorized_by,
      reason,
      input.created_by,
      this.s.now(),
    );
    if (authorized_by) return this.dispatch(id, authorized_by, reason!);
    return this.result(this.get(id), target);
  }
  get(id: string): Outbox {
    const o = this.s.one<Outbox>("SELECT * FROM outbox WHERE id=?", id);
    if (!o) throw new Error("Draft not found");
    return o;
  }
  list(): Outbox[] {
    return this.s.all(
      "SELECT * FROM outbox WHERE status='draft' ORDER BY created_at,id",
    );
  }
  approve(id: string, authorized_by: string, reason: string) {
    if (!authorized_by.trim() || !reason.trim())
      throw new Error("Approval requires actor and reason");
    return this.dispatch(id, authorized_by, reason);
  }
  reject(id: string, actor: string, reason: string) {
    const o = this.get(id);
    if (o.status !== "draft")
      throw new Error("Only draft messages can be rejected");
    this.s.run(
      "UPDATE outbox SET status='rejected',authorized_by=?,reason=?,decided_at=? WHERE id=? AND status='draft'",
      actor,
      reason,
      this.s.now(),
      id,
    );
    const handle = this.handles.get(o.handle_id);
    const conversation = o.conversation_id
      ? this.conversations.get(o.conversation_id)
      : undefined;
    return this.result(this.get(id), {
      person_id: o.person_id,
      handle_id: o.handle_id,
      handle: handle.value_normalized,
      channel: o.channel,
      account_id: handle.account_id,
      conversation_id: conversation?.id,
      conversationExternalId: conversation?.external_id,
      conversationKind: conversation?.kind,
    });
  }
  private result(o: Outbox, target: SendTarget) {
    return {
      ...o,
      person: this.identity.get(target.person_id),
      handle: this.handles.get(target.handle_id),
      channel: target.channel,
      target,
    };
  }
  private async dispatch(id: string, actor: string, reason: string) {
    const o = this.get(id);
    if (o.status !== "draft")
      throw new Error("Only draft messages can be approved/sent");
    const target = this.resolve({
      person_id: o.person_id,
      conversation_id: o.conversation_id ?? undefined,
      handle_id: o.handle_id,
      channel: o.channel,
    });
    // Reserve the slot transactionally before awaiting the external adapter.
    this.s.db.transaction(() => {
      if (this.get(id).status !== "draft")
        throw new Error("Draft already claimed");
      this.checks(target, o.payload);
      this.s.run(
        "UPDATE outbox SET status='approved',authorized_by=?,reason=?,decided_at=? WHERE id=?",
        actor,
        reason,
        this.s.now(),
        id,
      );
      this.s.run("UPDATE outbox SET status='sending' WHERE id=?", id);
    })();
    let sent: { externalId: string; conversationExternalId: string };
    try {
      sent = await (this.hooks.send
        ? this.hooks.send(id, target, o.payload)
        : this.registry.get(target.channel).send(target, o.payload));
    } catch (error) {
      this.s.run(
        "UPDATE outbox SET status='failed',error=? WHERE id=?",
        String(error),
        id,
      );
      return this.result(this.get(id), target);
    }
    // Keep 'sending' on a persistence failure: a real send must never be retried blindly.
    this.s.db.transaction(() => {
      const conversation = this.conversations.upsert(
        target.channel,
        target.account_id,
        sent.conversationExternalId,
        target.conversationKind ?? "direct",
      );
      this.s.run(
        "INSERT OR IGNORE INTO conversation_participants VALUES (?,?)",
        conversation.id,
        target.handle_id,
      );
      const existing = this.s.one<{
        id: string;
        direction: string;
        conversation_id: string;
      }>(
        "SELECT id,direction,conversation_id FROM messages WHERE channel=? AND external_id=?",
        target.channel,
        sent.externalId,
      );
      if (
        existing &&
        (existing.direction !== "out" ||
          existing.conversation_id !== conversation.id)
      )
        throw new Error("Confirmed send conflicts with ingested message");
      const messageId = existing?.id ?? this.s.id("m");
      if (!existing)
        this.s.run(
          "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          messageId,
          conversation.id,
          target.channel,
          sent.externalId,
          "out",
          null,
          this.s.now(),
          o.payload.text,
          o.payload.subject ?? null,
          JSON.stringify(o.payload.email_to ?? []),
          JSON.stringify(o.payload.email_cc ?? []),
          JSON.stringify(o.payload.email_bcc ?? []),
          JSON.stringify(o.payload.attachments ?? []),
          o.payload.reply_to_external_id ?? null,
          JSON.stringify({ source: "outbox", outbox_id: id }),
          this.s.now(),
        );
      this.s.run(
        "UPDATE outbox SET status='sent',conversation_id=?,sent_message_id=? WHERE id=?",
        conversation.id,
        messageId,
        id,
      );
      target.conversation_id = conversation.id;
      target.conversationExternalId = conversation.external_id;
    })();
    await this.hooks.afterSent?.(id);
    return this.result(this.get(id), target);
  }
}
