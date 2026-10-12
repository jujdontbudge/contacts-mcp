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
import type { Handle, Message, Outbox, SendRequest } from "./types.js";
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
    implicitConversation = true,
  ): SendTarget {
    let conversation = input.conversation_id
      ? this.conversations.get(input.conversation_id)
      : undefined;
    const explicit = input.handle_id
      ? this.handles.get(input.handle_id)
      : undefined;
    if (explicit && !explicit.person_id)
      throw new Error(
        "Handle is unlinked; link_handle with exact identity proof first",
      );
    let personId = input.person_id ?? explicit?.person_id;
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

    if (explicit && explicit.person_id !== personId)
      throw new Error("Handle does not belong to person");
    let channel = conversation?.channel ?? input.channel ?? explicit?.channel;
    if (!conversation && implicitConversation) {
      conversation = this.conversations
        .list(personId, channel)
        // Never pick a group implicitly: messaging a group needs an explicit conversation_id.
        .find(
          (c) =>
            c.kind === "direct" &&
            (!explicit ||
              (c.channel === explicit.channel &&
                c.account_id === explicit.account_id &&
                !!this.s.one(
                  "SELECT 1 FROM conversation_participants WHERE conversation_id=? AND handle_id=?",
                  c.id,
                  explicit.id,
                ))),
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
    const handle = this.handles.get(target.handle_id);
    let normalized: string;
    try { normalized = this.registry.normalize(handle.channel, handle.value_raw); }
    catch { throw new Error("Stored handle normalization changed; review the raw value with change_handle before sending"); }
    if (normalized !== handle.value_normalized)
      throw new Error("Stored handle normalization changed; verify identity and use change_handle before sending");
    if (handle.person_id !== target.person_id)
      throw new Error("Handle no longer belongs to person");
    if (handle.value_normalized !== target.handle || handle.account_id !== target.account_id || handle.channel !== target.channel)
      throw new Error("Selected handle changed; verify the recipient and create a new draft");
    if (channel.accountId && channel.accountId !== target.account_id)
      throw new Error("Handle account does not match the configured sending account");
    if (target.conversation_id) {
      const conversation = this.conversations.get(target.conversation_id);
      if (conversation.kind !== target.conversationKind || conversation.account_id !== target.account_id || conversation.external_id !== target.conversationExternalId)
        throw new Error("Selected conversation changed; verify the target and create a new draft");
    }
    if (content.email_to?.length && target.channel !== "email")
      throw new Error("Channel does not support email recipients");
    if (target.channel === "email" && content.email_to?.length &&
        !content.email_to.some(value => this.registry.normalize("email", value) === target.handle))
      throw new Error("email_to must include the selected handle; choose the correct person/handle first");
    if (content.reply_to_external_id) {
      let reply = this.s.one<{ conversation_id: string }>(
        "SELECT conversation_id FROM messages WHERE channel=? AND external_id=?",
        target.channel, content.reply_to_external_id,
      );
      if (!reply && target.channel === "email") {
        const event = this.conversations.lookupEvent("email", content.reply_to_external_id);
        if (event?.account_id === target.account_id) reply = this.s.one(
          "SELECT id AS conversation_id FROM conversations WHERE channel='email' AND account_id=? AND external_id=?",
          target.account_id, event.conversation_external_id,
        );
      }
      if (!reply || reply.conversation_id !== target.conversation_id)
        throw new Error("Reply message must belong to the selected conversation");
    }
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
        !last || !Number.isFinite(Date.parse(last.sent_at)) || this.s.clock().getTime() < Date.parse(last.sent_at) ||
        this.s.clock().getTime() - Date.parse(last.sent_at) >=
          (target.channel === "instagram" &&
          content.metadata?.instagram_tag === "HUMAN_AGENT"
            ? 168
            : channel.capabilities.replyWindowHours) *
            3600000
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
      // An email into an existing thread replies to that thread's latest message,
      // so headers and subject keep it in the same thread for the recipient.
      reply_to_external_id:
        reply_to_external_id ??
        (target.channel === "email" && target.conversation_id
          ? this.s.one<{ external_id: string }>(
              "SELECT external_id FROM messages WHERE conversation_id=? ORDER BY sent_at DESC,rowid DESC LIMIT 1",
              target.conversation_id,
            )?.external_id
          : undefined),
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
      input.authorized_by ? input.reason! :
      (rule ? `Standing rule ${rule.id} (${rule.scope}:${rule.value})${input.reason ? `; ${input.reason}` : ""}` : input.reason ?? null);
    const id = this.s.id("o");
    this.s.run(
      "INSERT INTO outbox (id,status,person_id,conversation_id,handle_id,channel,payload,authorized_by,reason,created_by,created_at,target_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
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
      JSON.stringify(target),
    );
    if (authorized_by) return this.dispatch(id, authorized_by, reason!, input.authorized_by ? undefined : rule?.id);
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
    if (o.conversation_id && o.conversation_id !== target.conversation_id) {
      const conversation = this.conversations.get(o.conversation_id);
      target = { ...target, conversation_id: conversation.id, conversationExternalId: conversation.external_id, conversationKind: conversation.kind };
    }
    return {
      ...o,
      person: this.identity.get(target.person_id),
      handle: this.handles.get(target.handle_id),
      channel: target.channel,
      target,
    };
  }
  private async dispatch(id: string, actor: string, reason: string, ruleId?: string) {
    const o = this.get(id);
    if (o.status !== "draft")
      throw new Error("Only draft messages can be approved/sent");
    const target = this.resolve({
      person_id: o.person_id,
      conversation_id: o.conversation_id ?? undefined,
      handle_id: o.handle_id,
      channel: o.channel,
    }, false);
    if (o.target_snapshot && JSON.stringify(target) !== JSON.stringify(o.target_snapshot))
      throw new Error("Draft target changed; create a new draft after verifying the recipient");
    if (!o.target_snapshot && this.s.one(
      "SELECT 1 FROM handle_events WHERE handle_id=? AND action IN ('change','link','unlink') AND at>=?",
      o.handle_id, o.created_at,
    )) throw new Error("Legacy draft handle changed; create a new draft after verifying the recipient");
    // Reserve the slot transactionally before awaiting the external adapter.
    const reserved = this.s.db.transaction(() => {
      if (this.get(id).status !== "draft")
        throw new Error("Draft already claimed");
      if (ruleId && !this.s.one("SELECT 1 FROM send_rules WHERE id=? AND active=1", ruleId)) {
        this.s.run("UPDATE outbox SET authorized_by=NULL,reason=NULL WHERE id=?", id);
        return false;
      }
      this.checks(target, o.payload);
      this.s.run(
        "UPDATE outbox SET status='approved',authorized_by=?,reason=?,decided_at=? WHERE id=?",
        actor,
        reason,
        this.s.now(),
        id,
      );
      this.s.run("UPDATE outbox SET status='sending',send_started_sequence=(SELECT COALESCE(MAX(rowid),0) FROM messages) WHERE id=?", id);
      return true;
    }).immediate();
    if (!reserved) return this.result(this.get(id), target);
    let sent: { externalId: string; conversationExternalId: string };
    try {
      sent = await (this.hooks.send
        ? this.hooks.send(id, target, o.payload)
        : this.registry.get(target.channel).send(target, o.payload));
    } catch (error) {
      this.s.run(
        "UPDATE outbox SET status='failed',error=? WHERE id=? AND status='sending'",
        String(error),
        id,
      );
      // Live ingestion may have raced ahead of the adapter's uncertain result.
      const matches = this.s.all<Message>(
        "SELECT * FROM messages WHERE channel=? AND direction='out' AND text=? AND sent_at>=?",
        o.channel, o.payload.text, o.decided_at ?? this.get(id).decided_at ?? o.created_at,
      );
      if (matches.length === 1) this.reconcileFailed(matches[0]);
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
        sequence: number;
      }>(
        "SELECT id,direction,conversation_id,rowid AS sequence FROM messages WHERE channel=? AND external_id=?",
        target.channel,
        sent.externalId,
      );
      if (
        existing &&
        (existing.direction !== "out" ||
          existing.conversation_id !== conversation.id)
      )
        throw new Error("Confirmed send conflicts with ingested message");
      const startedSequence = this.get(id).send_started_sequence;
      if (existing && startedSequence !== null && existing.sequence <= startedSequence)
        throw new Error("Confirmed send reused a message stored before dispatch; reconcile manually");
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

  /** Evidence only: never dispatches or retries. Ambiguous fingerprints stay failed. */
  reconcileFailed(message: Message): void {
    this.s.db.transaction(() => this.reconcileMessage(message)).immediate();
  }
  private reconcileMessage(message: Message): void {
    if (message.direction !== "out" || !message.text.trim()) return;
    const provider = (message.raw as { message?: { sendStatus?: { status?: string } } } | null)?.message;
    if (provider?.sendStatus && provider.sendStatus.status !== "SUCCESS") return;
    if (this.s.one("SELECT 1 FROM outbox WHERE sent_message_id=?", message.id)) return;
    const conversation = this.conversations.get(message.conversation_id);
    const sequence = this.s.one<{ sequence: number }>("SELECT rowid AS sequence FROM messages WHERE id=?", message.id)!.sequence;
    const candidates = this.s.all<Outbox>(
      "SELECT o.* FROM outbox o JOIN handles h ON h.id=o.handle_id WHERE o.status='failed' AND o.channel=? AND h.account_id=? AND json_extract(o.payload,'$.text')=? AND (o.conversation_id=? OR (o.conversation_id IS NULL AND ?='direct' AND EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id=? AND cp.handle_id=o.handle_id)))",
      message.channel, conversation.account_id, message.text, conversation.id, conversation.kind, conversation.id,
    ).filter(o => {
      const age = Date.parse(message.sent_at) - Date.parse(o.decided_at ?? o.created_at);
      if (o.send_started_sequence !== null && sequence <= o.send_started_sequence) return false;
      if (age < -1000 || age > 10 * 60_000 || !Number.isFinite(age) || o.payload.attachments?.length) return false;
      const handle = this.handles.get(o.handle_id);
      if (o.target_snapshot && (o.target_snapshot.handle !== handle.value_normalized || o.target_snapshot.account_id !== conversation.account_id)) return false;
      if (message.channel === "email") {
        const same = (a: string[] = [], b: string[] = []) => JSON.stringify([...new Set(a.map(v => this.registry.normalize("email", v)))].sort()) === JSON.stringify([...new Set(b.map(v => this.registry.normalize("email", v)))].sort());
        if (!same(o.payload.email_to?.length ? o.payload.email_to : [handle.value_normalized], message.email_to) || !same(o.payload.email_cc, message.email_cc) || !same(o.payload.email_bcc, message.email_bcc)) return false;
        if (o.payload.subject !== undefined && o.payload.subject !== message.subject) return false;
      }
      return true;
    });
    if (candidates.length !== 1) return;
    this.s.run(
      "UPDATE outbox SET status='sent',sent_message_id=?,conversation_id=?,reconciled_at=? WHERE id=? AND status='failed'",
      message.id, conversation.id, this.s.now(), candidates[0].id,
    );
  }
}
