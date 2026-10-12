import { normalizeHandle, type Channel, type IngestEvent, type SendContent, type SendTarget } from "./channel.js";

type RecordValue = Record<string, unknown>;
type Watermark = { time: string; ids: string[]; lastInboundAt?: string };
type Cursor = { version: 1; accountId: string; conversations: Record<string, Watermark> };
export interface TikTokOptions {
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}
/** Persist getCursor() only after the yielded events have been ingested successfully. */
export interface TikTokChannel extends Channel {
  getCursor(): string;
  getLastInboundAt(conversationExternalId: string): string | undefined;
}
const object = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
const required = (value: unknown, field: string): string => {
  const result = string(value);
  if (!result) throw new Error(`Zernio response missing ${field}`);
  return result;
};
const userHandle = (id: string) => `tiktok:user:${id}`;
const messageId = (account: string, conversation: string, id: string) =>
  `zernio:${encodeURIComponent(account)}:${encodeURIComponent(conversation)}:${encodeURIComponent(id)}`;

export function createTikTokChannel(opts: TikTokOptions = {}): TikTokChannel {
  const apiKey = opts.apiKey ?? process.env.ZERNIO_API_KEY;
  const accountId = opts.accountId ?? process.env.ZERNIO_TIKTOK_ACCOUNT_ID;
  if (!apiKey?.trim()) throw new Error("ZERNIO_API_KEY is required");
  if (!accountId?.trim()) throw new Error("ZERNIO_TIKTOK_ACCOUNT_ID is required");
  const baseUrl = (opts.baseUrl ?? process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api").replace(/\/+$/, "");
  const http = opts.fetch ?? globalThis.fetch;
  const clock = opts.clock ?? (() => new Date());
  let state: Cursor = { version: 1, accountId, conversations: Object.create(null) };
  // Serialise sends from this instance; upstream remains authoritative across processes.
  let sendQueue: Promise<unknown> = Promise.resolve();

  async function request(path: string, params: Record<string, string> = {}, body?: RecordValue): Promise<RecordValue> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await http(url, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    let data: RecordValue;
    try { data = object(await response.json()); }
    catch { throw new Error(`Zernio returned non-JSON HTTP ${response.status}; ${body ? "send outcome unknown; reconcile before retrying" : "sync not checkpointed"}`); }
    if (!response.ok || data.success === false) {
      const detail = [string(data.error), string(data.code), string(object(data.platformError).message)].filter(Boolean).join("; ");
      const retry = response.headers.get("retry-after");
      if (/window|48.?hour|48.?h\b|expired.*reply|reply.*expired/i.test(detail))
        throw new Error(`TikTok reply window is closed (48 hours after the latest inbound message). ${detail}`);
      if (response.status === 429 || /rate.?limit|quota|message.?limit|10 messages|too many/i.test(detail))
        throw new Error(`TikTok/Zernio rate limit reached (up to 10 replies per inbound window)${retry ? `; Retry-After: ${retry}` : ""}. ${detail}`);
      throw new Error(`Zernio HTTP ${response.status}: ${detail || "request failed"}${body && response.status >= 500 ? "; send outcome unknown; reconcile before retrying" : ""}`);
    }
    const meta = object(data.meta);
    const failures = Array.isArray(meta.failedAccounts) ? meta.failedAccounts : [];
    const skipped = Array.isArray(meta.accountsSkipped) ? meta.accountsSkipped : [];
    if (failures.some(f => object(f).accountId === accountId) || skipped.some(f => object(f).accountId === accountId) || Number(meta.accountsFailed ?? 0) > 0)
      throw new Error("Zernio could not read the TikTok account; check Business connection and messaging permissions (sync not checkpointed)");
    return data;
  }

  async function* pages(path: string, key: string, params: Record<string, string>): AsyncIterable<RecordValue> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const data = await request(path, { ...params, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data[key])) throw new Error(`Zernio response missing ${key} array`);
      for (const value of data[key]) yield object(value);
      const pagination = object(data.pagination);
      const next = string(pagination.nextCursor);
      if (pagination.hasMore === false) return;
      if (!next) {
        if (pagination.hasMore === true) throw new Error("Zernio pagination hasMore without nextCursor");
        return;
      }
      if (seen.has(next)) throw new Error("Zernio repeated pagination cursor");
      seen.add(next);
      cursor = next;
    } while (cursor);
  }

  function mapMessage(conversation: RecordValue, message: RecordValue): IngestEvent {
    const conversationId = required(conversation.id, "conversation id");
    const id = required(message.id ?? message.platformMessageId, "message id");
    const direction = message.direction === "incoming" || message.direction === "in" ? "in"
      : message.direction === "outgoing" || message.direction === "out" ? "out" : undefined;
    if (!direction) throw new Error("Zernio response has unknown message direction");
    const timestamp = required(message.createdAt ?? message.sentAt, "message timestamp");
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Zernio response has invalid message timestamp");
    const participant = object(conversation.participant);
    const remoteId = string(conversation.participantId) ?? string(participant.id);
    const username = string(conversation.participantUsername) ?? string(participant.username);
    const sender = string(message.senderId) ?? string(object(message.sender).id) ?? (direction === "in" ? remoteId : undefined);
    if (direction === "in" && !sender) throw new Error("Zernio response missing inbound sender id");
    const attachments = (Array.isArray(message.attachments) ? message.attachments : []).map(object)
      .filter(a => string(a.url)).map(a => ({ url: string(a.url)!, ...(string(a.mimeType) ? { mimeType: string(a.mimeType) } : {}), ...(string(a.filename ?? a.name) ? { name: string(a.filename ?? a.name) } : {}) }));
    const quoted = string(object(message.metadata).quotedMessageId);
    return {
      channel: "tiktok", account_id: accountId!,
      external_id: messageId(accountId!, conversationId, id), conversation_external_id: conversationId,
      kind: "direct", title: string(conversation.participantName) ?? username,
      participants: [...new Set([...(remoteId ? [userHandle(remoteId)] : []), ...(username ? [`@${username.replace(/^@/, "")}`] : [])])],
      sender: sender ? userHandle(sender) : `tiktok:account:${accountId}`,
      direction, sent_at: new Date(timestamp).toISOString(), text: string(message.message ?? message.text) ?? "",
      attachments,
      ...(quoted ? { reply_to_external_id: messageId(accountId!, conversationId, quoted) } : {}),
      raw: { conversation, message },
    };
  }

  async function messages(conversation: RecordValue): Promise<IngestEvent[]> {
    const id = required(conversation.id, "conversation id");
    const events = new Map<string, IngestEvent>();
    for await (const message of pages(`/v1/inbox/conversations/${encodeURIComponent(id)}/messages`, "messages", { accountId: accountId!, limit: "100", sortOrder: "asc" })) {
      if (string(message.accountId) && message.accountId !== accountId) throw new Error("Zernio message account mismatch");
      if (string(message.platform) && message.platform !== "tiktok") throw new Error("Zernio message platform mismatch");
      if (string(message.conversationId) && message.conversationId !== id) throw new Error("Zernio message conversation mismatch");
      const event = mapMessage(conversation, message);
      events.set(event.external_id, event);
    }
    return [...events.values()].sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.external_id.localeCompare(b.external_id));
  }

  function decode(cursor: string): Cursor {
    try {
      const value = object(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (value.version !== 1 || value.accountId !== accountId || !value.conversations || Array.isArray(value.conversations) || typeof value.conversations !== "object") throw new Error();
      for (const item of Object.values(object(value.conversations))) {
        const mark = object(item);
        if (!string(mark.time) || !Number.isFinite(Date.parse(mark.time as string)) || !Array.isArray(mark.ids) || !mark.ids.every(id => typeof id === "string") || (mark.lastInboundAt !== undefined && !Number.isFinite(Date.parse(mark.lastInboundAt as string)))) throw new Error();
      }
      return { ...value, conversations: Object.assign(Object.create(null), value.conversations) } as unknown as Cursor;
    } catch { throw new Error("Invalid TikTok sync cursor or account mismatch"); }
  }

  async function send(target: SendTarget, content: SendContent) {
    if (!target.conversationExternalId?.trim()) throw new Error("TikTok cannot start conversations; a human must send the first message");
    if (target.channel !== "tiktok" || target.account_id !== accountId) throw new Error("TikTok send account/channel mismatch");
    if (target.conversationKind === "group") throw new Error("TikTok does not support groups");
    if (content.email_cc?.length || content.email_bcc?.length || content.email_to?.length || content.subject) throw new Error("TikTok does not support email fields or CC/BCC");
    if (content.reply_to_external_id) throw new Error("TikTok quote-replies are not documented; reply to the conversation instead");
    if (content.text.length > 6000) throw new Error("TikTok text limit is 6000 characters");
    if ((content.attachments?.length ?? 0) > 1) throw new Error("TikTok supports one JPG or PNG image per message");
    const attachment = content.attachments?.[0];
    if (attachment && !["image/jpeg", "image/png"].includes(attachment.mimeType ?? "")) throw new Error("TikTok attachment must declare image/jpeg or image/png (maximum 3 MB, enforced upstream)");
    if (!content.text.trim() && !attachment) throw new Error("TikTok message cannot be empty");
    const id = target.conversationExternalId;
    const history = await messages({ id });
    const lastInboundAt = history.filter(e => e.direction === "in").at(-1)?.sent_at;
    if (!lastInboundAt || clock().getTime() - Date.parse(lastInboundAt) >= 48 * 3600000) throw new Error("TikTok reply window is closed (48 hours after the latest inbound message)");
    if (history.filter(e => e.direction === "out" && e.sent_at >= lastInboundAt).length >= 10) throw new Error("TikTok rate limit reached: 10 business messages since the latest inbound message; wait for a new inbound message");
    const data = await request(`/v1/inbox/conversations/${encodeURIComponent(id)}/messages`, { accountId: accountId!, platform: "tiktok" }, {
      accountId, message: content.text, ...(attachment ? { attachmentUrl: attachment.url, attachmentType: "image" } : {}),
    });
    const result = object(data.data);
    return { externalId: messageId(accountId!, id, required(result.messageId, "sent message id; reconcile before retrying")), conversationExternalId: id };
  }

  return {
    id: "tiktok", capabilities: { startConversation: false, groups: false, cc: false, replyWindowHours: 48 },
    normalizeHandle(raw) {
      // Opaque TikTok user IDs are case-sensitive; usernames are not.
      return /^tiktok:(user|account):/.test(raw.trim()) ? raw.trim() : normalizeHandle("tiktok", raw);
    },
    getCursor: () => Buffer.from(JSON.stringify(state)).toString("base64url"),
    getLastInboundAt: id => state.conversations[id]?.lastInboundAt,
    async *sync(cursor) {
      state = cursor ? decode(cursor) : { version: 1, accountId: accountId!, conversations: Object.create(null) };
      for await (const conversation of pages("/v1/inbox/conversations", "data", { accountId: accountId!, platform: "tiktok", limit: "100" })) {
        if (string(conversation.accountId) && conversation.accountId !== accountId) continue;
        if (string(conversation.platform) && conversation.platform !== "tiktok") continue;
        if (conversation.isGroup === true) throw new Error("Unexpected TikTok group conversation");
        const id = required(conversation.id, "conversation id");
        const previous = state.conversations[id];
        for (const event of await messages(conversation)) {
          if (previous && (event.sent_at < previous.time || (event.sent_at === previous.time && previous.ids.includes(event.external_id)))) continue;
          yield event;
          // Reached only when the consumer resumes after successful ingestion.
          const mark = state.conversations[id];
          state.conversations[id] = {
            time: event.sent_at,
            ids: mark?.time === event.sent_at ? [...new Set([...mark.ids, event.external_id])] : [event.external_id],
            lastInboundAt: event.direction === "in" ? event.sent_at : mark?.lastInboundAt,
          };
        }
      }
    },
    send(target, content) {
      const pending = sendQueue.then(() => send(target, content));
      sendQueue = pending.catch(() => undefined);
      return pending;
    },
  };
}
