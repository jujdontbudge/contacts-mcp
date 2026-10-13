import { normalizeHandle, type Channel, type HandleProfile, type IngestEvent, type SendContent, type SendTarget } from "./channel.js";

type RecordValue = Record<string, unknown>;
type Mark = { time: string; ids: string[] };
type Cursor = { version: 1; accountId: string; companyId?: string; conversations: Record<string, Mark> };
type Thread = { type: "support" | "dm"; id: string; raw: RecordValue; peers: RecordValue[]; own: string[] };
export interface SideShiftOptions {
  apiKey?: string;
  accountId?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  getOutboxId?: () => string;
}
const object = (v: unknown): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const string = (v: unknown): string | undefined => typeof v === "string" && v.length ? v : undefined;
const required = (v: unknown, field: string): string => {
  const result = string(v);
  if (!result) throw new Error(`SideShift response missing ${field}`);
  return result;
};
const safeCodes = new Set(["invalid_request", "unauthorized", "subscription_required", "insufficient_scope", "forbidden", "not_found", "conflict", "idempotency_conflict", "rate_limited", "upstream_error", "internal"]);
/** Provider error text and transport exceptions can echo credentials: never include them. */
export class SideShiftError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly uncertain = false) {
    super(`SideShift ${code} (HTTP ${status})${uncertain ? "; send outcome unknown; reconcile before retrying" : ""}`);
    this.name = "SideShiftError";
  }
}
export function createSideShiftChannel(opts: SideShiftOptions = {}): Channel & { getCursor(): string } {
  const apiKey = opts.apiKey ?? process.env.SIDESHIFT_API_KEY;
  if (!apiKey?.trim()) throw new Error("SIDESHIFT_API_KEY is required");
  const accountId = opts.accountId ?? "default";
  const baseUrl = (opts.baseUrl ?? "https://app.sideshift.app/api/oauth/v1").replace(/\/+$/, "");
  const http = opts.fetch ?? globalThis.fetch;
  const clock = opts.clock ?? (() => new Date());
  const sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const empty = (): Cursor => ({ version: 1, accountId, conversations: Object.create(null) });
  let state = empty();
  let companyId: string | undefined;
  let jobs: RecordValue[] | undefined;
  let blockedUntil = 0;
  let requestQueue: Promise<unknown> = Promise.resolve();
  const external = (id: string, message: string) => `sideshift:${encodeURIComponent(accountId)}:${encodeURIComponent(id)}:${encodeURIComponent(message)}`;
  const cursor = () => Buffer.from(JSON.stringify(state)).toString("base64url");
  function decode(value: string): Cursor {
    try {
      const parsed = object(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
      if (parsed.version !== 1 || parsed.accountId !== accountId || !parsed.conversations || Array.isArray(parsed.conversations) || typeof parsed.conversations !== "object" || (parsed.companyId !== undefined && !string(parsed.companyId))) throw new Error();
      for (const mark of Object.values(object(parsed.conversations))) {
        const item = object(mark);
        if (!string(item.time) || !Number.isFinite(Date.parse(item.time as string)) || !Array.isArray(item.ids) || !item.ids.every(id => typeof id === "string")) throw new Error();
      }
      return { version: 1, accountId, companyId: string(parsed.companyId), conversations: Object.assign(Object.create(null), parsed.conversations) } as Cursor;
    } catch { throw new Error("Invalid SideShift sync cursor or account mismatch"); }
  }
  async function perform(path: string, params: Record<string, string>, body?: RecordValue, key?: string): Promise<RecordValue> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      if (blockedUntil > clock().getTime()) await sleep(blockedUntil - clock().getTime());
      let response: Response;
      try {
        response = await http(url, { method: body ? "POST" : "GET", headers: { "x-api-key": apiKey!, ...(body ? { "Content-Type": "application/json", "Idempotency-Key": key! } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: "error" });
      } catch { throw new SideShiftError("transport_error", 0, !!body); }
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) blockedUntil = Math.max(blockedUntil, reset);
      let data: RecordValue;
      try { data = object(await response.json()); }
      catch { throw new SideShiftError("invalid_response", response.status, !!body); }
      const error = object(data.error);
      if (!response.ok || data.error) {
        const code = safeCodes.has(String(error.code)) ? String(error.code) : "request_failed";
        if (response.status === 429) {
          const retry = Number(response.headers.get("retry-after") ?? object(error.meta).retryAfterSeconds ?? 60);
          const delay = Math.max(Number.isFinite(retry) ? Math.max(0, retry) * 1000 : 60_000, 1000 * 2 ** attempt) + Math.floor(random() * 1000);
          blockedUntil = Math.max(blockedUntil, clock().getTime() + delay);
          // Reads only: bounded retry. A provider dispatch is never repeated by core or adapter.
          if (!body && attempt < 3) continue;
        }
        throw new SideShiftError(code, response.status, !!body && response.status >= 500);
      }
      return data;
    }
  }
  function request(path: string, params: Record<string, string> = {}, body?: RecordValue, key?: string) {
    const pending = requestQueue.then(() => perform(path, params, body, key));
    requestQueue = pending.catch(() => undefined);
    return pending;
  }
  async function* pages(path: string, params: Record<string, string> = {}): AsyncIterable<RecordValue> {
    let next: string | undefined;
    const seen = new Set<string>();
    do {
      const data = await request(path, { limit: "100", ...params, ...(next ? { cursor: next } : {}) });
      if (!Array.isArray(data.data) || typeof data.hasMore !== "boolean") throw new SideShiftError("invalid_page", 200);
      for (const item of data.data) yield object(item);
      if (!data.hasMore) return;
      next = required(data.nextCursor, "nextCursor when hasMore");
      if (seen.has(next)) throw new Error("SideShift repeated pagination cursor");
      seen.add(next);
    } while (next);
  }
  async function loadJobs() {
    const data = await request("/jobs", { limit: "100" });
    if (!Array.isArray(data.data)) throw new SideShiftError("invalid_jobs", 200);
    // This endpoint is not paginated; reaching the cap cannot prove complete discovery.
    if (data.data.length >= 100) throw new Error("SideShift jobs reached the non-paginated 100-job cap; applicant discovery cannot prove completeness");
    jobs = data.data.map(object);
    const companies = new Set(jobs.map(j => required(j.companyId, "job companyId")));
    if (companies.size > 1) throw new Error("SideShift jobs span multiple company tenants");
    companyId = [...companies][0];
  }
  function profile(user: RecordValue, jobId?: string): HandleProfile | undefined {
    const id = string(user.userId ?? user.id);
    if (!id || id === companyId) return undefined;
    const socials: HandleProfile["related_handles"] = [];
    for (const channel of ["instagram", "tiktok"] as const) {
      let value = string(user[channel]);
      if (!value) continue;
      if (/^https?:\/\//.test(value)) {
        try { const url = new URL(value); if (url.hostname !== `${channel}.com` && url.hostname !== `www.${channel}.com`) continue; value = url.pathname.split("/").filter(Boolean)[0]; }
        catch { continue; }
      }
      if (value && /^@?[\w.]+$/.test(value)) socials.push({ channel, value: normalizeHandle(channel, value) });
    }
    return { channel: "sideshift", account_id: accountId, value: id,
      ...(string(user.name) ? { display_name: string(user.name) } : {}),
      // Do not invent a public URL from an opaque ID. Preserve a profile URL only if exposed.
      ...(string(user.profileUrl) ? { profile_url: string(user.profileUrl) } : {}),
      ...(string(user.profileImageUrl) ? { profile_image_url: string(user.profileImageUrl) } : {}),
      job_ids: jobId ? [jobId] : [], related_handles: socials,
    };
  }
  async function threads(): Promise<Thread[]> {
    const result = new Map<string, Thread>();
    for await (const raw of pages("/support-channels")) {
      const id = required(raw.id, "support channel id");
      const user = object(raw.customerUser);
      const peer = { ...user, id: string(raw.customerUserId), name: raw.customerName ?? user.name };
      result.set(`support:${id}`, { type: "support", id, raw, peers: [peer], own: companyId ? [companyId] : [] });
    }
    for await (const raw of pages("/conversations")) {
      if (raw.isSystemNotification === true) continue;
      const id = required(raw.id, "conversation id");
      if (!Array.isArray(raw.participants) || raw.participants.some(p => !string(object(p).id))) throw new SideShiftError("participant_identity_unresolved", 200);
      const peers = raw.participants.map(object).filter(p => p.id !== companyId);
      if (!peers.length) throw new SideShiftError("participant_identity_unresolved", 200);
      // The native API's participants projection contains counterpart users; members also
      // carries the company identities. Never use members as recipient handles.
      const peerIds = new Set(peers.map(p => string(p.id)));
      const own = [...new Set([...(companyId ? [companyId] : []), ...(Array.isArray(raw.members) ? raw.members.filter((m): m is string => typeof m === "string" && !peerIds.has(m)) : [])])];
      const support = result.get(`support:${id}`) ?? (raw.chatType !== "native" && string(raw.channelId) ? result.get(`support:${raw.channelId}`) : undefined);
      if (support) { support.own = [...new Set([...support.own, ...own])]; continue; }
      const type = raw.kind === "support" ? "support" : "dm";
      result.set(`${type}:${id}`, { type, id, raw, peers, own });
    }
    return [...result.values()];
  }
  function mapMessage(thread: Thread, message: RecordValue): IngestEvent {
    const id = required(message.id, "message id");
    const timestamp = required(message.createdAt ?? message.timestamp, "message timestamp");
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error("SideShift response has invalid message timestamp");
    const remoteIds = thread.peers.map(p => string(p.id)).filter((id): id is string => !!id);
    const senderId = string(message.senderUserId);
    const senderExternal = string(message.senderExternalUserId);
    const peer = thread.peers.find(p => (senderId && p.id === senderId) || (senderExternal && p.externalUserId === senderExternal));
    const isOwn = senderId ? thread.own.includes(senderId) : false;
    // A support channel has one customer. Other resolved users are company senders;
    // they remain outgoing sender metadata, never messageable participants.
    const supportOwn = thread.type === "support" && senderId && remoteIds.length === 1 && !peer;
    const storedOwn = message.source === "stored" && string(message.sender) && thread.own.includes(String(message.sender));
    const direction = peer ? "in" : isOwn || supportOwn || storedOwn ? "out" : undefined;
    if (!direction) throw new Error("SideShift sender identity unresolved; refusing to guess message direction");
    const sender = senderId ?? (peer ? `provider:${required(senderExternal, "provider sender id")}` : companyId ?? required(message.sender, "stored sender id"));
    const participants = thread.peers.map(p => string(p.id) ?? (string(p.externalUserId) ? `provider:${p.externalUserId}` : undefined)).filter((id): id is string => !!id && !thread.own.includes(id));
    const attachments = (Array.isArray(message.attachments) ? message.attachments : []).map(object).filter(a => string(a.url)).map(a => ({ url: String(a.url), ...(string(a.mimeType) ? { mimeType: String(a.mimeType) } : {}), ...(string(a.name) ? { name: String(a.name) } : {}) }));
    return { channel: "sideshift", account_id: accountId, external_id: external(thread.id, id), conversation_external_id: `${thread.type}:${thread.id}`,
      kind: participants.length > 1 ? "group" : "direct", title: string(thread.raw.groupName ?? thread.raw.customName ?? thread.raw.customerName) ?? string(thread.peers[0]?.name),
      participants, own_handles: thread.own, sender, direction, sent_at: new Date(timestamp).toISOString(),
      text: string(message.content) ?? "", attachments,
      ...(string(message.replyingToMessageId) ? { reply_to_external_id: external(thread.id, String(message.replyingToMessageId)) } : {}),
      handle_profiles: thread.peers.map(p => profile(p)).filter((p): p is HandleProfile => !!p), raw: { conversation: thread.raw, message },
    };
  }
  return {
    id: "sideshift", accountId, capabilities: { startConversation: true, groups: false, cc: false },
    normalizeHandle: raw => normalizeHandle("sideshift", raw), getCursor: cursor,
    async *syncProfiles(saved) {
      const previous = saved ? decode(saved) : undefined;
      await loadJobs();
      if (previous?.companyId && companyId && previous.companyId !== companyId) throw new Error("SideShift sync tenant changed; configure a separate account/database");
      for (const job of jobs!) for await (const applicant of pages("/applicants", { jobId: required(job.id, "job id") })) {
        const value = profile({ ...applicant, userId: required(applicant.userId, "applicant userId") }, String(job.id));
        if (value) yield value;
      }
    },
    async *sync(saved, checkpoint) {
      state = saved ? decode(saved) : empty();
      if (!jobs) await loadJobs();
      if (state.companyId && companyId && state.companyId !== companyId) throw new Error("SideShift sync tenant changed; configure a separate account/database");
      state.companyId = companyId ?? state.companyId;
      try {
        for (const thread of await threads()) {
          const key = `${thread.type}:${thread.id}`;
          const previous = state.conversations[key];
          const events = new Map<string, IngestEvent>();
          for await (const message of pages(`/${thread.type === "support" ? "support-channels" : "conversations"}/${encodeURIComponent(thread.id)}/messages`)) {
            const event = mapMessage(thread, message);
            events.set(event.external_id, event);
          }
          for (const event of [...events.values()].sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.external_id.localeCompare(b.external_id))) {
            if (previous && (event.sent_at < previous.time || (event.sent_at === previous.time && previous.ids.includes(event.external_id)))) continue;
            yield event;
            const mark = state.conversations[key];
            state.conversations[key] = { time: event.sent_at, ids: mark?.time === event.sent_at ? [...new Set([...mark.ids, event.external_id])] : [event.external_id] };
          }
          checkpoint?.(cursor());
        }
      } finally { jobs = undefined; }
    },
    async send(target: SendTarget, content: SendContent) {
      if (target.channel !== "sideshift" || target.account_id !== accountId) throw new Error("SideShift send account/channel mismatch");
      if (target.conversationKind === "group") throw new Error("SideShift group sends are not supported");
      if (content.subject || content.email_to?.length || content.email_cc?.length || content.email_bcc?.length || content.attachments?.length || content.reply_to_external_id || content.metadata?.instagram_tag) throw new Error("SideShift supports plain text conversation replies only; email, attachments and quote-replies are unsupported");
      if (!content.text.trim() || content.text.length > 10000) throw new Error("SideShift text must be 1–10000 characters");
      const key = opts.getOutboxId?.();
      if (!key?.trim()) throw new Error("SideShift send requires an active outbox dispatch ID");
      let result: RecordValue;
      let threadId: string;
      let type: "support" | "dm";
      let messageId: string;
      if (target.conversationExternalId) {
        const match = /^(support|dm):(.+)$/.exec(target.conversationExternalId);
        if (!match) throw new Error("Invalid SideShift conversation route");
        type = match[1] as "support" | "dm"; threadId = match[2];
        result = object((await request(type === "support" ? `/support-channels/${encodeURIComponent(threadId)}/messages` : "/messages", {}, { content: content.text, ...(type === "dm" ? { conversationId: threadId } : {}) }, key)).data);
        if (result.delivered !== true) throw new SideShiftError("delivery_unconfirmed", 201, true);
        const returnedThread = required(type === "support" ? result.channelId : result.conversationId, "sent conversation id; reconcile before retrying");
        if (returnedThread !== threadId) throw new SideShiftError("send_route_changed", 201, true);
        messageId = required(type === "support" ? result.id : result.externalMessageId ?? result.messageId, "sent message id; reconcile before retrying");
      } else {
        const jobId = content.metadata?.sideshift_job_id;
        if (!jobId?.trim()) throw new Error("New SideShift applicant message requires metadata.sideshift_job_id");
        if (target.handle.startsWith("provider:")) throw new Error("New SideShift applicant message requires a SideShift user ID");
        result = object((await request("/applicants/message", {}, { applicantId: target.handle, jobId, message: content.text, includeJobLink: false }, key)).data);
        if (result.success !== true || !Array.isArray(result.messageIds) || result.messageIds.length !== 1) throw new SideShiftError("delivery_unconfirmed", 201, true);
        threadId = required(result.supportChannelId, "supportChannelId; reconcile before retrying"); type = "support";
        messageId = required(result.messageIds[0], "sent message id; reconcile before retrying");
      }
      return { externalId: external(threadId, messageId), conversationExternalId: `${type}:${threadId}` };
    },
  };
}
