import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTikTokChannel } from "../src/channels/tiktok.js";
import type { IngestEvent, SendTarget } from "../src/channels/channel.js";
import { ContactsCore } from "../src/core/index.js";
import { ChannelRegistry } from "../src/channels/registry.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/zernio/${name}.json`, import.meta.url), "utf8"));
const now = () => new Date("2026-10-12T12:00:00Z");
const target: SendTarget = { person_id: "p", handle_id: "h", handle: "@alice", channel: "tiktok", account_id: "acct-1", conversationExternalId: "thread/opaque:1", conversationKind: "direct" };
const last = { pagination: { hasMore: false, nextCursor: null } };
function setup(responses: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const http = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected HTTP call");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  }) as unknown as typeof fetch;
  const channel = createTikTokChannel({ apiKey: "offline-key", accountId: "acct-1", fetch: http, clock: now });
  return { channel, calls, http };
}
async function collect(events: AsyncIterable<IngestEvent>) {
  const results: IngestEvent[] = [];
  for await (const event of events) results.push(event);
  return results;
}
const history = () => ({ ...fixture("messages"), ...last });
const syncResponses = () => [
  { body: fixture("conversations") }, { body: fixture("messages") },
  { body: fixture("messages-page-2") }, { body: { data: [], ...last } },
];

describe("TikTok Zernio adapter (offline)", () => {
  it("maps stable IDs, usernames, directions, timestamps, media and unknown raw fields", async () => {
    const { channel, calls } = setup(syncResponses());
    const events = await collect(channel.sync());
    expect(events).toHaveLength(3);
    const incoming = events.find(e => e.text === "Hello")!;
    expect(incoming).toMatchObject({ account_id: "acct-1", conversation_external_id: "thread/opaque:1", external_id: "zernio:acct-1:thread%2Fopaque%3A1:native-in", sender: "tiktok:user:UserCase1", direction: "in", sent_at: "2026-10-12T10:00:00.000Z", participants: ["tiktok:user:UserCase1", "@Alice"], attachments: [{ url: "https://cdn.example/photo.png", mimeType: "image/png", name: "photo.png" }] });
    expect(incoming.raw).toMatchObject({ conversation: { futureField: { keep: true } }, message: { futureMessageField: 42, attachments: [{ width: 1080 }] } });
    expect(events.find(e => e.direction === "out")).toMatchObject({ sender: "tiktok:user:BusinessCase1", reply_to_external_id: incoming.external_id });
    expect(events.find(e => e.external_id.endsWith("native-in-2"))?.text).toBe("");
    expect(channel.getLastInboundAt("thread/opaque:1")).toBe("2026-10-12T11:00:00.000Z");
    expect(calls[0].url.origin + calls[0].url.pathname).toBe("https://zernio.com/api/v1/inbox/conversations");
    expect(calls[0].url.searchParams.get("platform")).toBe("tiktok");
    expect(calls.every(c => c.url.searchParams.get("accountId") === "acct-1")).toBe(true);
    expect(calls[1].url.pathname).toContain("thread%2Fopaque%3A1/messages");
    expect(calls[2].url.searchParams.get("cursor")).toBe("message-page-2");
    expect(calls[3].url.searchParams.get("cursor")).toBe("conversation-page-2");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer offline-key" });
    expect(channel.normalizeHandle(" @ALIce ")).toBe("alice");
    expect(channel.normalizeHandle("tiktok:user:UserCase1")).toBe("tiktok:user:UserCase1");
  });

  it("resumes per conversation across restarts, including new IDs at the same timestamp", async () => {
    const first = setup(syncResponses());
    await collect(first.channel.sync());
    const cursor = first.channel.getCursor();
    const nextHistory = { messages: [...history().messages, ...fixture("messages-page-2").messages, { ...history().messages[0], id: "late-same-time", createdAt: "2026-10-12T11:00:00Z" }], ...last };
    const second = setup([{ body: { data: [fixture("conversations").data[0]], ...last } }, { body: nextHistory }]);
    const events = await collect(second.channel.sync(cursor));
    expect(events.map(e => e.external_id)).toEqual(["zernio:acct-1:thread%2Fopaque%3A1:late-same-time"]);
    expect(second.channel.getLastInboundAt("thread/opaque:1")).toBe("2026-10-12T11:00:00.000Z");
  });

  it("does not checkpoint an event until the consumer resumes after ingesting it", async () => {
    const { channel } = setup(syncResponses());
    const iterator = channel.sync()[Symbol.asyncIterator]();
    const empty = channel.getCursor();
    await iterator.next();
    expect(channel.getCursor()).toBe(empty);
    await iterator.next();
    expect(channel.getCursor()).not.toBe(empty);
    await iterator.return?.();
  });

  it("reads subsequent conversations and sorts pages rather than trusting platform order", async () => {
    const conv = fixture("conversations").data[0];
    const { channel } = setup([
      { body: { data: [conv], pagination: { hasMore: true, nextCursor: "next" } } },
      { body: { messages: history().messages.toReversed(), ...last } },
      { body: { data: [{ ...conv, id: "another" }], ...last } },
      { body: { messages: [{ ...history().messages[0], conversationId: "another" }], ...last } },
    ]);
    const events = await collect(channel.sync());
    expect(events.map(e => e.direction)).toEqual(["in", "out", "in"]);
    expect(events[0].external_id).not.toBe(events[2].external_id);
  });

  it("sends only to an existing opaque thread and reconciles the same namespaced message ID", async () => {
    const { channel, calls } = setup([{ body: history() }, { body: fixture("send") }]);
    expect(await channel.send(target, { text: "Reply" })).toEqual({ externalId: "zernio:acct-1:thread%2Fopaque%3A1:sent-native", conversationExternalId: "thread/opaque:1" });
    expect(calls[1].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ accountId: "acct-1", message: "Reply" });
    expect(channel.capabilities).toEqual({ startConversation: false, groups: false, cc: false, replyWindowHours: 48 });
  });

  it("supports one declared JPG/PNG image", async () => {
    const { channel, calls } = setup([{ body: history() }, { body: fixture("send") }]);
    await channel.send(target, { text: "", attachments: [{ url: "https://cdn.example/photo.png", mimeType: "image/png" }] });
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ attachmentUrl: "https://cdn.example/photo.png", attachmentType: "image" });
  });

  it("refuses to start a conversation without making HTTP calls", async () => {
    const { channel, calls } = setup([]);
    await expect(channel.send({ ...target, conversationExternalId: undefined }, { text: "Hello" })).rejects.toThrow("human must send the first message");
    expect(calls).toHaveLength(0);
  });

  it.each([
    [{ ...target, account_id: "other" }, { text: "Hi" }, "mismatch"],
    [{ ...target, conversationKind: "group" }, { text: "Hi" }, "groups"],
    [target, { text: "Hi", email_cc: ["x"] }, "CC/BCC"],
    [target, { text: "x".repeat(6001) }, "6000"],
    [target, { text: "" }, "empty"],
    [target, { text: "Hi", attachments: [{ url: "https://cdn.example/file", mimeType: "video/mp4" }] }, "image/jpeg"],
  ])("rejects unsupported target/content before HTTP", async (sendTarget, content, error) => {
    const { channel, calls } = setup([]);
    await expect(channel.send(sendTarget as SendTarget, content)).rejects.toThrow(error);
    expect(calls).toHaveLength(0);
  });

  it.each([{ messages: [] }, { messages: [{ ...history().messages[0], createdAt: "2026-10-10T12:00:00Z" }] }])("rejects absent/expired inbound including the exact 48-hour boundary", async ({ messages }) => {
    const { channel, calls } = setup([{ body: { messages, ...last } }]);
    await expect(channel.send(target, { text: "Reply" })).rejects.toThrow("window is closed");
    expect(calls).toHaveLength(1);
  });

  it("counts human/business replies across pages and rejects the eleventh", async () => {
    const outgoing = Array.from({ length: 10 }, (_, i) => ({ ...history().messages[1], id: `out-${i}` }));
    const { channel, calls } = setup([
      { body: { messages: [history().messages[0], ...outgoing.slice(0, 5)], pagination: { hasMore: true, nextCursor: "next" } } },
      { body: { messages: outgoing.slice(5), ...last } },
    ]);
    await expect(channel.send(target, { text: "Reply" })).rejects.toThrow("10 business messages");
    expect(calls).toHaveLength(2);
  });

  it("a new inbound message resets the business quota", async () => {
    const { channel } = setup([
      { body: { messages: [history().messages[0], ...Array.from({ length: 10 }, (_, i) => ({ ...history().messages[1], id: `out-${i}` })), { ...history().messages[0], id: "new-in", createdAt: "2026-10-12T11:30:00Z" }], ...last } },
      { body: fixture("send") },
    ]);
    await expect(channel.send(target, { text: "Reply" })).resolves.toHaveProperty("externalId");
  });

  it.each([
    [400, "window-error", {}, "window is closed"],
    [429, "rate-error", { "Retry-After": "120" }, "Retry-After: 120"],
    [401, "rate-error", {}, "rate limit reached"],
  ])("maps platform errors without retrying sends", async (status, name, headers, expected) => {
    const { channel, calls } = setup([{ body: history() }, { body: fixture(name), status, headers }]);
    await expect(channel.send(target, { text: "Reply" })).rejects.toThrow(expected);
    expect(calls).toHaveLength(2);
  });

  it("reports ambiguous upstream failures without retrying", async () => {
    const { channel, calls } = setup([{ body: history() }, { body: { error: "upstream failure" }, status: 503 }]);
    await expect(channel.send(target, { text: "Reply" })).rejects.toThrow("reconcile before retrying");
    expect(calls).toHaveLength(2);
  });

  it.each(["bad-cursor", Buffer.from(JSON.stringify({ version: 1, accountId: "other", conversations: {} })).toString("base64url")])("rejects invalid/account-mismatched cursor before HTTP", async cursor => {
    const { channel, calls } = setup([]);
    await expect(collect(channel.sync(cursor))).rejects.toThrow("Invalid TikTok sync cursor");
    expect(calls).toHaveLength(0);
  });

  it.each([
    { data: [], pagination: { hasMore: true } },
    { data: [], meta: { failedAccounts: [{ accountId: "acct-1" }] }, ...last },
    { data: [], meta: { accountsSkipped: [{ accountId: "acct-1" }] }, ...last },
    { data: "unexpected" },
  ])("fails closed on incomplete listings rather than pretending to sync", async body => {
    const { channel } = setup([{ body }]);
    await expect(collect(channel.sync())).rejects.toThrow("Zernio");
  });

  it("rejects repeated opaque pagination cursors", async () => {
    const page = { data: [], pagination: { hasMore: true, nextCursor: "same" } };
    const { channel } = setup([{ body: page }, { body: page }]);
    await expect(collect(channel.sync())).rejects.toThrow("repeated pagination cursor");
  });

  it("stored inbound timestamps drive core reply-window enforcement without a hook", async () => {
    const { channel, calls } = setup(syncResponses());
    const core = new ContactsCore({ path: ":memory:", registry: new ChannelRegistry([channel]), clock: () => new Date("2026-10-14T11:00:00Z") });
    try {
      const person = core.identity.create({ display_name: "Alice" });
      core.handles.add({ channel: "tiktok", account_id: "acct-1", value: "tiktok:user:UserCase1", person_id: person.id, actor: "test", reason: "Exact TikTok ID proof" });
      for await (const event of channel.sync()) core.ingest(event);
      const conversation = core.conversations.list(person.id, "tiktok")[0];
      await expect(core.outbox.send({ person_id: person.id, conversation_id: conversation.id, text: "Reply", created_by: "test", authorized_by: "test", reason: "offline test" })).rejects.toThrow("Reply window is closed");
      expect(calls).toHaveLength(4);
    } finally { core.close(); }
  });
  it("uses configured base URL and reports authentication errors", async () => {
    const http = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({ error: "Invalid API key", code: "invalid_credentials" }), { status: 401 }));
    const channel = createTikTokChannel({ apiKey: "offline", accountId: "acct-1", baseUrl: "https://offline.example/custom/", fetch: http });
    await expect(collect(channel.sync())).rejects.toThrow("Zernio HTTP 401: Invalid API key");
    expect(String(http.mock.calls[0][0])).toContain("https://offline.example/custom/v1/inbox/conversations?");
  });

  it("rejects non-JSON errors and malformed message direction without advancing cursor", async () => {
    const http = vi.fn(async () => new Response("upstream HTML error", { status: 502 }));
    const channel = createTikTokChannel({ apiKey: "offline", accountId: "acct-1", fetch: http });
    await expect(collect(channel.sync())).rejects.toThrow("non-JSON HTTP 502");
    const malformed = setup([
      { body: { data: [fixture("conversations").data[0]], ...last } },
      { body: { messages: [{ ...history().messages[0], direction: "unknown" }], ...last } },
    ]);
    const cursor = malformed.channel.getCursor();
    await expect(collect(malformed.channel.sync())).rejects.toThrow("unknown message direction");
    expect(malformed.channel.getCursor()).toBe(cursor);
  });

  it("preserves the checkpoint if a later message page fails", async () => {
    const { channel } = setup([
      { body: { data: [fixture("conversations").data[0]], ...last } },
      { body: fixture("messages") },
      { body: { error: "bad gateway" }, status: 502 },
    ]);
    const cursor = channel.getCursor();
    await expect(collect(channel.sync())).rejects.toThrow("bad gateway");
    expect(channel.getCursor()).toBe(cursor);
  });

  it("handles opaque conversation IDs that match object prototype keys", async () => {
    const conv = { ...fixture("conversations").data[0], id: "__proto__" };
    const message = { ...history().messages[0], conversationId: "__proto__" };
    const { channel } = setup([{ body: { data: [conv], ...last } }, { body: { messages: [message], ...last } }]);
    expect(await collect(channel.sync())).toHaveLength(1);
    expect(channel.getLastInboundAt("__proto__")).toBe("2026-10-12T10:00:00.000Z");
    const resumed = setup([{ body: { data: [conv], ...last } }, { body: { messages: [message], ...last } }]);
    expect(await collect(resumed.channel.sync(channel.getCursor()))).toEqual([]);
  });

  it("core authorized send and later sync reconcile into one outgoing message", async () => {
    const { channel } = setup([...syncResponses(), { body: history() }, { body: fixture("send") }]);
    const core = new ContactsCore({ path: ":memory:", registry: new ChannelRegistry([channel]), clock: now });
    try {
      const person = core.identity.create({ display_name: "Alice" });
      core.handles.add({ channel: "tiktok", account_id: "acct-1", value: "tiktok:user:UserCase1", person_id: person.id, actor: "test", reason: "Exact TikTok ID proof" });
      for await (const event of channel.sync()) core.ingest(event);
      const conversation = core.conversations.list(person.id, "tiktok")[0];
      const before = core.conversations.detail(conversation.id).messages.length;
      await core.outbox.send({ person_id: person.id, conversation_id: conversation.id, text: "Reply", created_by: "test", authorized_by: "test", reason: "offline test" });
      core.ingest({ channel: "tiktok", account_id: "acct-1", conversation_external_id: "thread/opaque:1", external_id: "zernio:acct-1:thread%2Fopaque%3A1:sent-native", sender: "tiktok:user:BusinessCase1", direction: "out", sent_at: now().toISOString(), text: "Reply" });
      expect(core.conversations.detail(conversation.id).messages).toHaveLength(before + 1);
    } finally { core.close(); }
  });

  it("deduplicates overlapping message pages before counting the reply quota", async () => {
    const outbound = Array.from({ length: 5 }, (_, i) => ({ ...history().messages[1], id: `out-${i}` }));
    const { channel } = setup([
      { body: { messages: [history().messages[0], ...outbound], pagination: { hasMore: true, nextCursor: "overlap" } } },
      { body: { messages: outbound, ...last } },
      { body: fixture("send") },
    ]);
    await expect(channel.send(target, { text: "Reply" })).resolves.toHaveProperty("externalId");
  });

});
