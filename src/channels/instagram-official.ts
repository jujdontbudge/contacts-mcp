import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeHandle, type Channel, type IngestEvent } from "./channel.js";

interface User { id: string; username?: string }
interface Page<T> { data: T[]; paging?: { next?: string; cursors?: { after?: string } } }
interface Conversation { id: string; participants: Page<User> }
interface Message {
  id: string; created_time: string; from: User; to: Page<User>; message?: string;
  attachments?: Page<{ image_data?: { url?: string }; video_data?: { url?: string }; file_url?: string; mime_type?: string; name?: string }>;
}
interface Position { ids: string[]; lastInboundAt?: string }
interface Cursor { version: 1; userId: string; conversations: Record<string, Position> }
export interface InstagramToken { accessToken: string; refreshedAt: string }
export interface InstagramOfficialOptions {
  accessToken?: string;
  userId?: string;
  /** Logical contacts account; both transports use the Beeper account ID. */
  accountId?: string;
  version?: string;
  appSecret?: string;
  verifyToken?: string;
  fetch?: typeof fetch;
  clock?: () => Date;
  loadToken?: () => InstagramToken | undefined;
  saveToken?: (token: InstagramToken) => void;
  getLastInboundAt?: (conversationExternalId: string) => string | undefined;
}
export interface InstagramOfficialChannel extends Channel {
  resolveUserId(): Promise<string>;
  refreshAccessToken(): Promise<void>;
  handleWebhook(req: IncomingMessage, res: ServerResponse, ingest: (event: IngestEvent) => void): Promise<void>;
}
export function officialMessageId(userId: string, mid: string): string {
  return `ig:${encodeURIComponent(userId)}:message:${encodeURIComponent(mid)}`;
}
function threadId(userId: string, peer: string): string {
  return `ig:${encodeURIComponent(userId)}:user:${encodeURIComponent(peer)}`;
}
function scopedHandle(userId: string, peer: string): string { return `igsid:${userId}:${peer}`; }
const WEEK = 7 * 24 * 3600000;

export function verifyInstagramSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const supplied = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createInstagramOfficialChannel(opts: InstagramOfficialOptions = {}): InstagramOfficialChannel {
  const initialToken = opts.accessToken ?? process.env.IG_ACCESS_TOKEN;
  if (!initialToken?.trim()) throw new Error("IG_ACCESS_TOKEN is required");
  const version = opts.version ?? process.env.IG_GRAPH_VERSION ?? "v25.0";
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("Invalid IG_GRAPH_VERSION");
  const http = opts.fetch ?? fetch;
  const clock = opts.clock ?? (() => new Date());
  const appSecret = opts.appSecret ?? process.env.IG_APP_SECRET;
  const verifyToken = opts.verifyToken ?? process.env.IG_WEBHOOK_VERIFY_TOKEN;
  let selfId = opts.userId?.trim() || process.env.IG_USER_ID?.trim() || undefined;
  let token: InstagramToken | undefined;
  let cursor: string | undefined;
  const inbound = new Map<string, string>();
  let refreshing: Promise<void> | undefined;
  function credentials(): InstagramToken {
    if (!token) {
      token = opts.loadToken?.() ?? { accessToken: initialToken!, refreshedAt: clock().toISOString() };
      opts.saveToken?.(token);
    }
    return token;
  }
  async function request<T>(path: string, params: Record<string, string> = {}, body?: unknown, unversioned = false): Promise<T> {
    const url = new URL(`https://graph.instagram.com/${unversioned ? "" : `${version}/`}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // Refresh requires the token parameter; all other calls keep credentials out of URLs.
    if (unversioned) url.searchParams.set("access_token", credentials().accessToken);
    let response: Response;
    try {
      response = await http(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${credentials().accessToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", signal: AbortSignal.timeout(30000),
      });
    } catch { throw new Error("Instagram API request failed; reconcile writes before retrying"); }
    // Provider bodies and fetch errors can contain credentials. Never include them in diagnostics.
    if (!response.ok) throw new Error(`Instagram API HTTP ${response.status}; reconcile writes before retrying`);
    try { return await response.json() as T; }
    catch { throw new Error("Invalid Instagram API response"); }
  }
  async function resolveUserId(): Promise<string> {
    if (!selfId) {
      const me = await request<{ id?: string; user_id?: string }>("me", { fields: "user_id,username" });
      selfId = me.user_id ?? me.id;
    }
    if (!selfId) throw new Error("Instagram /me returned no user ID");
    return selfId;
  }
  async function* pages<T>(path: string, params: Record<string, string>, cap = Infinity): AsyncIterable<T> {
    let after: string | undefined;
    const seen = new Set<string>();
    let count = 0;
    do {
      const page = await request<Page<T>>(path, { ...params, ...(after ? { after } : {}), ...(Number.isFinite(cap) ? { limit: String(cap - count) } : {}) });
      if (!Array.isArray(page.data)) throw new Error("Invalid Instagram page");
      for (const item of page.data) { if (count++ >= cap) return; yield item; }
      if (count >= cap || !page.paging?.next) return;
      // Never follow provider-supplied URLs carrying tokens or an untrusted origin.
      after = page.paging.cursors?.after;
      if (!after || seen.has(after)) throw new Error("Broken Instagram pagination");
      seen.add(after);
    } while (after);
  }
  async function conversations(): Promise<Conversation[]> {
    const self = await resolveUserId();
    const result: Conversation[] = [];
    for await (const c of pages<Conversation>(`${encodeURIComponent(self)}/conversations`, { platform: "instagram", fields: "id,participants", limit: "100" })) {
      if (!c.id || !Array.isArray(c.participants?.data) || c.participants.paging?.next) throw new Error("Incomplete Instagram conversation participants");
      if (!c.participants.data.some(p => p.id === self)) throw new Error("Instagram conversation account mismatch");
      if (c.participants.data.filter(p => p.id !== self).length !== 1) throw new Error("Instagram only supports direct conversations");
      result.push(c);
    }
    return result;
  }
  async function messages(c: Conversation): Promise<Message[]> {
    const result: Message[] = [];
    // Only the latest 20 message details are accessible. Never walk older history.
    let after: string | undefined;
    const seen = new Set<string>();
    while (result.length < 20) {
      const remaining = 20 - result.length;
      const field = `messages.limit(${remaining})${after ? `.after(${after})` : ""}{id,created_time}`;
      const node = await request<{ messages: Page<Partial<Message>> }>(encodeURIComponent(c.id), { fields: field });
      const page = node.messages;
      if (!Array.isArray(page?.data)) throw new Error("Invalid Instagram message page");
      for (const item of page.data.slice(0, remaining)) {
        if (!item.id) throw new Error("Instagram message has no ID");
        const m = item.created_time && item.from && item.to ? item as Message : await request<Message>(encodeURIComponent(item.id), { fields: "id,created_time,from,to,message,attachments" });
        if (m.id !== item.id || !Number.isFinite(Date.parse(m.created_time)) || !m.from?.id || !Array.isArray(m.to?.data)) throw new Error("Invalid Instagram message");
        result.push(m);
      }
      if (result.length >= 20 || !page.paging?.next) break;
      after = page.paging.cursors?.after;
      // Cursor is embedded in Graph field expansion; fail closed on unsafe syntax.
      if (!after || !/^[A-Za-z0-9_=-]+$/.test(after) || seen.has(after)) throw new Error("Broken Instagram message pagination");
      seen.add(after);
    }
    return result.sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time) || a.id.localeCompare(b.id));
  }
  function remember(id: string, at: string): void {
    if (!inbound.has(id) || Date.parse(at) > Date.parse(inbound.get(id)!)) inbound.set(id, at);
  }
  function map(c: Conversation, m: Message, self: string): IngestEvent {
    const peer = c.participants.data.find(p => p.id !== self)!;
    if (![self, peer.id].includes(m.from.id) || !m.to.data.some(p => p.id === (m.from.id === self ? peer.id : self))) throw new Error("Instagram message participant mismatch");
    const conversationId = threadId(self, peer.id);
    const direction = m.from.id === self ? "out" : "in";
    if (direction === "in") remember(conversationId, m.created_time);
    return {
      channel: "instagram", account_id: channel.accountId!, external_id: officialMessageId(self, m.id),
      conversation_external_id: conversationId, kind: "direct", title: peer.username,
      participants: [...new Set(c.participants.data.filter(p => p.id !== self).flatMap(p => [scopedHandle(self, p.id), ...(p.username ? [normalizeHandle("instagram", p.username)] : [])]))],
      own_handles: [scopedHandle(self, self), ...c.participants.data.filter(p => p.id === self && p.username).map(p => normalizeHandle("instagram", p.username!))],
      sender: scopedHandle(self, m.from.id), direction, sent_at: new Date(m.created_time).toISOString(), text: m.message ?? "",
      attachments: m.attachments?.data.flatMap(a => { const url = a.image_data?.url ?? a.video_data?.url ?? a.file_url; return url ? [{ url, mimeType: a.mime_type, name: a.name }] : []; }),
      raw: { transport: "official", conversation: c, message: m },
    };
  }
  const channel: InstagramOfficialChannel = {
    id: "instagram", accountId: opts.accountId ?? selfId ?? "official",
    capabilities: { startConversation: false, groups: false, cc: false, replyWindowHours: 24 },
    normalizeHandle: raw => normalizeHandle("instagram", raw), resolveUserId,
    getCursor: () => cursor,
    async *sync(encoded, checkpoint) {
      const self = await resolveUserId();
      let state: Cursor = { version: 1, userId: self, conversations: Object.create(null) };
      if (encoded) {
        state = JSON.parse(Buffer.from(encoded, "base64url").toString());
        if (state.version !== 1 || state.userId !== self || !state.conversations || typeof state.conversations !== "object" || Array.isArray(state.conversations)) throw new Error("Invalid official Instagram cursor/account");
        for (const p of Object.values(state.conversations)) {
          if (!p || !Array.isArray(p.ids) || !p.ids.every(id => typeof id === "string") || (p.lastInboundAt && !Number.isFinite(Date.parse(p.lastInboundAt)))) throw new Error("Invalid official Instagram cursor position");
        }
        state.conversations = Object.assign(Object.create(null), state.conversations);
      }
      const save = () => { cursor = Buffer.from(JSON.stringify(state)).toString("base64url"); checkpoint?.(cursor); };
      cursor = encoded;
      for (const c of await conversations()) {
        const previous = state.conversations[c.id];
        const peer = c.participants.data.find(p => p.id !== self)!;
        const thread = threadId(self, peer.id);
        if (previous?.lastInboundAt) remember(thread, previous.lastInboundAt);
        const recent = await messages(c);
        const consumed = new Set(previous?.ids ?? []);
        for (const m of recent) {
          const event = map(c, m, self);
          if (consumed.has(m.id)) continue;
          yield event;
          consumed.add(m.id);
          // Persist only after the consumer resumes following successful ingest.
          state.conversations[c.id] = { ids: [...consumed], lastInboundAt: inbound.get(thread) };
          save();
        }
        state.conversations[c.id] = { ids: recent.map(m => m.id), lastInboundAt: inbound.get(thread) };
        save();
      }
      save();
    },
    async send(target, content) {
      if (target.channel !== "instagram" || target.account_id !== channel.accountId) throw new Error("Instagram target account/channel mismatch");
      if (!target.conversationExternalId) throw new Error("Official Instagram cannot start conversations");
      if (target.conversationKind === "group" || content.attachments?.length || content.subject || content.email_to?.length || content.email_cc?.length || content.email_bcc?.length || content.reply_to_external_id) throw new Error("Official Instagram supports direct text replies only");
      if (!content.text.trim() || Buffer.byteLength(content.text, "utf8") > 1000) throw new Error("Instagram text must be 1-1000 UTF-8 bytes");
      const self = await resolveUserId();
      const requested = channel.normalizeHandle(target.handle);
      const matches = (await conversations()).filter(c => {
        const peer = c.participants.data.find(p => p.id !== self)!;
        return requested === scopedHandle(self, peer.id) || (!!peer.username && requested === normalizeHandle("instagram", peer.username));
      });
      if (matches.length !== 1) throw new Error("No unique existing official Instagram conversation for recipient");
      const c = matches[0], peer = c.participants.data.find(p => p.id !== self)!;
      const thread = threadId(self, peer.id);
      if (target.conversationExternalId.startsWith("ig:") && target.conversationExternalId !== thread) throw new Error("Instagram conversation/recipient mismatch");
      for (const m of await messages(c)) map(c, m, self);
      const stored = opts.getLastInboundAt?.(thread);
      if (stored) remember(thread, stored);
      const last = inbound.get(thread);
      const human = content.metadata?.instagram_tag === "HUMAN_AGENT";
      const age = last ? clock().getTime() - Date.parse(last) : Infinity;
      if (!Number.isFinite(age) || age < 0 || age >= (human ? WEEK : 24 * 3600000)) throw new Error("Instagram reply window is closed");
      const result = await request<{ recipient_id: string; message_id: string }>(`${encodeURIComponent(self)}/messages`, {}, {
        recipient: { id: peer.id }, message: { text: content.text },
        ...(human ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : {}),
      });
      if (!result.message_id || result.recipient_id !== peer.id) throw new Error("Instagram send confirmation mismatch; reconcile manually");
      return { externalId: officialMessageId(self, result.message_id), conversationExternalId: thread };
    },
    async refreshAccessToken() {
      const result = await request<{ access_token: string; expires_in: number }>("refresh_access_token", { grant_type: "ig_refresh_token" }, undefined, true);
      if (typeof result.access_token !== "string" || !result.access_token || !Number.isFinite(result.expires_in) || !(result.expires_in > 0)) throw new Error("Invalid Instagram refresh response");
      const next = { accessToken: result.access_token, refreshedAt: clock().toISOString() };
      opts.saveToken?.(next); // Persistence must succeed before replacing the active credential.
      token = next;
    },
    async maintenance() {
      if (clock().getTime() - Date.parse(credentials().refreshedAt) < WEEK) return;
      if (!refreshing) refreshing = channel.refreshAccessToken().finally(() => { refreshing = undefined; });
      await refreshing;
    },
    async handleWebhook(req, res, ingest) {
      if (!appSecret || !verifyToken) { res.writeHead(503); res.end(); return; }
      const url = new URL(req.url!, "http://localhost");
      if (req.method === "GET") {
        const supplied = Buffer.from(url.searchParams.get("hub.verify_token") ?? ""), expected = Buffer.from(verifyToken);
        const valid = url.searchParams.get("hub.mode") === "subscribe" && supplied.length === expected.length && timingSafeEqual(supplied, expected) && url.searchParams.has("hub.challenge");
        res.writeHead(valid ? 200 : 403, { "Content-Type": "text/plain" }); res.end(valid ? url.searchParams.get("hub.challenge") : "Forbidden"); return;
      }
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(b); }
      const body = Buffer.concat(chunks), signature = req.headers["x-hub-signature-256"];
      if (!verifyInstagramSignature(body, typeof signature === "string" ? signature : undefined, appSecret)) { res.writeHead(403); res.end(); return; }
      let payload: any;
      try { payload = JSON.parse(body.toString()); }
      catch { res.writeHead(400); res.end(); return; }
      if (!payload || payload.object !== "instagram" || !Array.isArray(payload.entry)) { res.writeHead(400); res.end(); return; }
      const self = await resolveUserId();
      for (const entry of payload.entry) {
        if (String(entry.id) !== self) continue;
        for (const event of entry.messaging ?? []) {
          if (!event.message?.mid) continue; // Ignore reads/reactions/postbacks.
          const outgoing = event.message.is_echo === true || event.sender?.id === self;
          const peer = outgoing ? event.recipient : event.sender;
          if (!peer?.id || (outgoing ? event.sender?.id !== self : event.recipient?.id !== self) || !Number.isFinite(event.timestamp)) throw new Error("Invalid Instagram webhook message");
          const c: Conversation = { id: threadId(self, peer.id), participants: { data: [{ id: self }, peer] } };
          const m: Message = { id: event.message.mid, from: outgoing ? { id: self } : peer, to: { data: [outgoing ? peer : { id: self }] }, created_time: new Date(event.timestamp).toISOString(), message: event.message.text };
          const mapped = map(c, m, self);
          mapped.attachments = (event.message.attachments ?? []).flatMap((a: any) => a.payload?.url ? [{ url: a.payload.url, mimeType: a.type }] : []);
          mapped.reply_to_external_id = event.message.reply_to?.mid ? officialMessageId(self, event.message.reply_to.mid) : undefined;
          mapped.raw = { transport: "official", webhook: event };
          ingest(mapped);
        }
      }
      res.writeHead(200); res.end("EVENT_RECEIVED");
    },
  };
  return channel;
}
