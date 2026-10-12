import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createInstagramOfficialChannel, officialMessageId, verifyInstagramSignature } from "../src/channels/instagram-official.js";
import { createInstagramBothChannel } from "../src/channels/instagram-transport.js";
import { configuredChannels, ChannelRegistry } from "../src/channels/registry.js";
import { createContactsSystem } from "../src/composition.js";
import { startDaemon, syncChannel } from "../src/daemon.js";
import { ContactsCore } from "../src/core/index.js";
import { FakeChannel } from "../src/channels/fake.js";
import { tools } from "../src/mcp/tools.js";
import type { IngestEvent, SendTarget } from "../src/channels/channel.js";
import { conversation, message, webhook, self, peer } from "./fixtures/instagram-official/data.js";

const clock = () => new Date("2026-10-12T12:00:00Z");
const target: SendTarget = { channel: "instagram", account_id: self, person_id: "person", handle_id: "handle", handle: `igsid:${self}:${peer}`, conversationExternalId: `ig:${self}:user:${peer}`, conversationKind: "direct" };
const env = { CONTACTS_CHANNELS: "instagram", CONTACTS_INSTAGRAM_TRANSPORT: "official", IG_USER_ID: self, IG_ACCESS_TOKEN: "fixture-token", IG_APP_SECRET: "fixture-secret", IG_WEBHOOK_VERIFY_TOKEN: "fixture-verify" };
function fixtureHttp(recent = [message("m1"), message("m2", "2026-10-12T11:00:00Z", true)]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const http: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    expect(url.host).toBe("graph.instagram.com");
    let body: unknown;
    if (url.pathname.endsWith("/me")) body = { user_id: self, username: "excerlock" };
    else if (url.pathname.endsWith("/conversations")) body = { data: [conversation] };
    else if (url.pathname.endsWith("/messages") && init.method === "POST") body = { recipient_id: peer, message_id: "sent-mid" };
    else if (url.pathname.endsWith("/thread-a")) body = { messages: { data: [...recent].reverse() } };
    else if (url.pathname === "/refresh_access_token") body = { access_token: "refreshed-fixture-token", expires_in: 5184000 };
    else throw new Error("Unexpected fixture endpoint");
    return new Response(JSON.stringify(body));
  };
  return { calls, http, options: { accessToken: "fixture-token", userId: self, fetch: http, clock, appSecret: "fixture-secret", verifyToken: "fixture-verify" } };
}
async function collect(channel: ReturnType<typeof createInstagramOfficialChannel>, cursor?: string) {
  const result: IngestEvent[] = []; for await (const event of channel.sync(cursor)) result.push(event); return result;
}
it("keeps the official account's scoped ID and username out of messageable participants", async () => {
  const f = fixtureHttp();
  const events = await collect(createInstagramOfficialChannel(f.options));
  expect(events.every(event => !event.participants!.includes(`igsid:${self}:${self}`) && !event.participants!.includes("excerlock"))).toBe(true);
});
it("maps IGSIDs, usernames, media, direction and raw data, and resumes by per-conversation IDs", async () => {
  const f = fixtureHttp(), channel = createInstagramOfficialChannel(f.options);
  const events = await collect(channel);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ account_id: self, sender: `igsid:${self}:${peer}`, external_id: officialMessageId(self, "m1"), conversation_external_id: target.conversationExternalId, direction: "in", text: "Hello", participants: [`igsid:${self}:${peer}`, "alice"], attachments: [{ url: "https://example.invalid/image.jpg" }], raw: { transport: "official", message: { id: "m1" } } });
  expect(events[1].direction).toBe("out");
  const cursor = channel.getCursor()!;
  expect(JSON.parse(Buffer.from(cursor, "base64url").toString()).conversations[conversation.id].lastInboundAt).toBe("2026-10-12T10:00:00Z");
  expect(await collect(createInstagramOfficialChannel(f.options), cursor)).toEqual([]);
  await expect(collect(createInstagramOfficialChannel({ ...f.options, userId: "wrong" }), cursor)).rejects.toThrow("cursor/account");
});
it("resolves /me, follows conversation and latest-20 pages, hydrates ID-only messages, never reads message 21", async () => {
  const calls: URL[] = [];
  const http: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url);
    let body: unknown;
    if (url.pathname.endsWith("/me")) body = { user_id: self };
    else if (url.pathname.endsWith("/conversations")) body = url.searchParams.has("after") ? { data: [{ ...conversation, id: "thread-b" }] } : { data: [conversation], paging: { next: "https://untrusted.invalid/?access_token=NEVER", cursors: { after: "next-conversations" } } };
    else if (/\/thread-[ab]$/.test(url.pathname)) {
      const field = url.searchParams.get("fields")!;
      const offset = field.includes(".after(") ? 10 : 0;
      expect(field).toContain(`messages.limit(${20 - offset})`);
      body = { messages: { data: Array.from({ length: 10 }, (_, i) => ({ id: `m${offset + i}` })), paging: { next: "https://untrusted.invalid/older", cursors: { after: offset ? "forbidden-third-page" : "next-messages" } } } };
    } else body = message(url.pathname.split("/").at(-1)!);
    return new Response(JSON.stringify(body));
  };
  const c = createInstagramOfficialChannel({ ...fixtureHttp().options, userId: undefined, fetch: http, accountId: "official" });
  expect(await collect(c)).toHaveLength(40);
  expect(calls.filter(u => /\/thread-[ab]$/.test(u.pathname))).toHaveLength(4);
  expect(calls.every(u => u.host === "graph.instagram.com" && !u.searchParams.has("access_token"))).toBe(true);
  expect(calls.some(u => u.searchParams.get("fields")?.includes("forbidden-third-page"))).toBe(false);
  expect(calls.filter(u => u.pathname.endsWith("/me"))).toHaveLength(1);
});
it("checkpoints only consumed events and safely replays after an interrupted ingest", async () => {
  const f = fixtureHttp(), channel = createInstagramOfficialChannel(f.options);
  const core = new ContactsCore({ path: ":memory:", registry: new ChannelRegistry([channel]) });
  const original = core.ingest.bind(core); let consumed = 0;
  const spy = vi.spyOn(core, "ingest").mockImplementation(event => { if (++consumed === 2) throw new Error("interrupted"); return original(event); });
  try {
    await expect(syncChannel(core, channel)).rejects.toThrow("interrupted");
    expect(core.conversations.search("")).toHaveLength(1);
    spy.mockRestore(); await syncChannel(core, channel);
    expect(core.conversations.search("")).toHaveLength(2);
  } finally { core.close(); }
});
it.each([24, 168])("refuses the exact %i hour boundary without a write", async hours => {
  const f = fixtureHttp([message("old", new Date(clock().getTime() - hours * 3600000).toISOString())]);
  const c = createInstagramOfficialChannel(f.options);
  await expect(c.send(target, { text: "no", ...(hours === 168 ? { metadata: { instagram_tag: "HUMAN_AGENT" as const } } : {}) })).rejects.toThrow("window");
  expect(f.calls.some(c => c.init.method === "POST")).toBe(false);
});
it("only adds HUMAN_AGENT when explicitly requested, sends to IGSID and confirms stable ID", async () => {
  const f = fixtureHttp(), c = createInstagramOfficialChannel(f.options);
  expect(c.capabilities).toMatchObject({ replyWindowHours: 24, startConversation: false });
  expect(await c.send(target, { text: "ordinary" })).toEqual({ externalId: officialMessageId(self, "sent-mid"), conversationExternalId: target.conversationExternalId });
  await c.send(target, { text: "human support", metadata: { instagram_tag: "HUMAN_AGENT" } });
  const bodies = f.calls.filter(c => c.init.method === "POST").map(c => JSON.parse(String(c.init.body)));
  expect(bodies[0]).toEqual({ recipient: { id: peer }, message: { text: "ordinary" } });
  expect(bodies[1]).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  const old = fixtureHttp([message("old", "2026-10-10T10:00:00Z")]);
  await createInstagramOfficialChannel(old.options).send(target, { text: "human support", metadata: { instagram_tag: "HUMAN_AGENT" } });
  expect(old.calls.at(-1)?.init.method).toBe("POST");
});
it("refuses cold starts, foreign targets, mismatched conversations, absent inbound, and unsupported reply/media", async () => {
  const f = fixtureHttp(), c = createInstagramOfficialChannel(f.options);
  for (const [t, content] of [
    [{ ...target, conversationExternalId: undefined }, { text: "x" }],
    [{ ...target, account_id: "wrong" }, { text: "x" }],
    [{ ...target, handle: "stranger" }, { text: "x" }],
    [{ ...target, conversationExternalId: "ig:1000:user:3000" }, { text: "x" }],
    [target, { text: "x", reply_to_external_id: "wrong" }],
    [target, { text: "x", attachments: [{ url: "file:///tmp/x" }] }],
  ] as const) await expect(c.send(t, content as any)).rejects.toThrow();
  const out = fixtureHttp([message("out-only", undefined, true)]);
  await expect(createInstagramOfficialChannel(out.options).send(target, { text: "x" })).rejects.toThrow("window");
  expect(f.calls.some(c => c.init.method === "POST")).toBe(false);
});
it("keeps transport failures and provider bodies containing tokens out of errors", async () => {
  for (const http of [async () => { throw new Error("SECRET in request URL"); }, async () => new Response("SECRET", { status: 401 })] as (typeof fetch)[]) {
    const c = createInstagramOfficialChannel({ ...fixtureHttp().options, fetch: http });
    try { await collect(c); throw new Error("expected failure"); } catch (e) { expect(String(e)).not.toContain("SECRET"); }
  }
});
it("validates signatures over exact raw bytes", () => {
  const body = Buffer.from(JSON.stringify(webhook()));
  const signature = "sha256=" + createHmac("sha256", "fixture-secret").update(body).digest("hex");
  expect(verifyInstagramSignature(body, signature, "fixture-secret")).toBe(true);
  for (const invalid of [undefined, "sha256=x", "sha256=" + "0".repeat(64), "sha1=" + signature.slice(7)]) expect(verifyInstagramSignature(body, invalid, "fixture-secret")).toBe(false);
  expect(verifyInstagramSignature(Buffer.concat([body, Buffer.from(" ")]), signature, "fixture-secret")).toBe(false);
});
it("serves GET verification without bearer auth and ingests signed incoming/phone echoes once; invalid signatures fail", async () => {
  const f = fixtureHttp();
  const system = await createContactsSystem({ env, path: ":memory:", clock, adapters: { instagramOfficial: { fetch: f.http } } });
  const daemon = await startDaemon(system.core, system.registry, { token: "mcp-secret", port: 0 });
  const url = `http://127.0.0.1:${(daemon.address as { port: number }).port}/webhooks/instagram`;
  try {
    const response = await fetch(url + "?hub.mode=subscribe&hub.verify_token=fixture-verify&hub.challenge=123456");
    expect(response.status).toBe(200); expect(await response.text()).toBe("123456");
    expect((await fetch(url + "?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x")).status).toBe(403);
    expect((await fetch(url.replace("/webhooks/instagram", "/mcp"))).status).toBe(401);
    const post = async (payload: unknown, valid = true) => {
      const body = JSON.stringify(payload);
      const signature = "sha256=" + createHmac("sha256", valid ? "fixture-secret" : "wrong").update(body).digest("hex");
      return fetch(url, { method: "POST", body, headers: { "X-Hub-Signature-256": signature } });
    };
    expect((await post(webhook(), false)).status).toBe(403);
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await post(webhook())).status).toBe(200);
    expect((await post(webhook())).status).toBe(200);
    expect((await post(webhook("inbound", false))).status).toBe(200);
    expect(system.core.conversations.search("Phone reply").filter(m => m.external_id === officialMessageId(self, "phone-echo"))).toHaveLength(1);
    expect(system.core.conversations.search("Hello").find(m => m.external_id === officialMessageId(self, "inbound"))?.direction).toBe("in");
    expect((await post({ ...webhook(), entry: [{ ...webhook().entry[0], id: "foreign-account" }] })).status).toBe(200);
    expect(system.core.conversations.search("").some(m => m.external_id.includes("foreign-account"))).toBe(false);
    expect((await post({ object: "instagram", entry: [{ id: self, messaging: [{ sender: { id: peer }, recipient: { id: self }, read: { mid: "read-only" } }] }] })).status).toBe(200);
    expect((await post({ object: "wrong", entry: [] })).status).toBe(400);
  } finally { await daemon.close(); system.core.close(); }
});
it("forwards explicit HUMAN_AGENT through MCP schema, draft persistence and approval's seven-day check", async () => {
  const f = fixtureHttp([message("old", "2026-10-10T10:00:00Z")]);
  const { core, registry } = await createContactsSystem({ path: ":memory:", env, clock, adapters: { instagramOfficial: { fetch: f.http } } });
  try {
    await syncChannel(core, registry.get("instagram"));
    const p = core.identity.create({ display_name: "Alice" });
    const h = core.handles.ensure("instagram", self, target.handle); core.handles.link(h.id, p.id, "owner", "test", "exact fixture ID");
    const api = tools(core);
    const input = api.send_message.schema.parse({ person_id: p.id, channel: "instagram", text: "Human support", metadata: { instagram_tag: "HUMAN_AGENT" }, created_by: "human" });
    const draft = await api.send_message.call(input);
    expect(core.outbox.get(draft.id).payload.metadata).toEqual({ instagram_tag: "HUMAN_AGENT" });
    expect((await core.outbox.approve(draft.id, "owner", "human support reply")).status).toBe("sent");
    await expect(core.outbox.send({ person_id: p.id, channel: "instagram", text: "untagged", created_by: "agent" })).rejects.toThrow("window");
  } finally { core.close(); }
});
it("persists weekly refreshed token, reloads it on restart and never exposes it in sync status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ig-official-")), path = join(dir, "db.sqlite");
  const f = fixtureHttp(); let now = clock();
  const options = { env, path, clock: () => now, adapters: { instagramOfficial: { fetch: f.http } } };
  let system = await createContactsSystem(options);
  try {
    await system.registry.get("instagram").maintenance!();
    expect(f.calls).toHaveLength(0);
    now = new Date(now.getTime() + 7 * 24 * 3600000);
    await system.registry.get("instagram").maintenance!();
    const refresh = f.calls.find(c => c.url.pathname === "/refresh_access_token")!;
    expect(refresh.url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(refresh.url.searchParams.get("access_token")).toBe("fixture-token");
    await system.registry.get("instagram").maintenance!();
    expect(f.calls.filter(c => c.url.pathname === "/refresh_access_token")).toHaveLength(1);
    expect(JSON.stringify(system.core.syncStatus())).not.toContain("fixture-token");
    system.core.close(); system = await createContactsSystem(options);
    await syncChannel(system.core, system.registry.get("instagram"));
    expect(f.calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer refreshed-fixture-token" });
  } finally { system.core.close(); rmSync(dir, { recursive: true, force: true }); }
});
it("selects default Beeper, official and both without network calls, rejects invalid configuration", async () => {
  const f = fixtureHttp();
  const official = await configuredChannels(env, { instagramOfficial: { fetch: f.http } });
  expect(official.get("instagram").capabilities.startConversation).toBe(false);
  for (const mode of [undefined, "beeper", "both"]) {
    const registry = await configuredChannels({ ...env, CONTACTS_INSTAGRAM_TRANSPORT: mode, BEEPER_ACCESS_TOKEN: "fake", BEEPER_INSTAGRAM_ACCOUNT_ID: "beeper-ig" }, { instagramOfficial: { fetch: f.http } });
    expect(registry.get("instagram").capabilities.startConversation).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("instagram").accountId).toBe("beeper-ig");
  }
  expect(f.calls).toHaveLength(0);
  const missing = await configuredChannels({ ...env, IG_ACCESS_TOKEN: undefined });
  expect(missing.disabled.get("instagram")?.reason).toContain("IG_ACCESS_TOKEN");
  await expect(configuredChannels({ ...env, CONTACTS_INSTAGRAM_TRANSPORT: "typo" })).rejects.toThrow("must be");
});
it("both routes new/cold DMs to Beeper, eligible replies to official, refuses expired replies and never falls back after failure", async () => {
  const beeper = new FakeChannel("instagram"); beeper.accountId = self;
  const f = fixtureHttp(), official = createInstagramOfficialChannel(f.options);
  const bsend = vi.spyOn(beeper, "send"), osend = vi.spyOn(official, "send");
  let last: string | undefined;
  const both = createInstagramBothChannel(beeper, official, { clock, getLastInboundAt: () => last });
  await both.send({ ...target, handle: "alice", conversationExternalId: undefined }, { text: "cold" });
  await both.send({ ...target, handle: "alice", conversationExternalId: "beeper-thread" }, { text: "cold-existing" });
  expect(bsend).toHaveBeenCalledTimes(2);
  last = "2026-10-12T10:00:00Z";
  await both.send({ ...target, handle: "alice", conversationExternalId: "beeper-thread" }, { text: "eligible" });
  expect(osend).toHaveBeenCalledOnce();
  last = "2026-10-10T10:00:00Z";
  await expect(both.send(target, { text: "expired" })).rejects.toThrow("window");
  last = "2026-10-12T10:00:00Z";
  osend.mockRejectedValueOnce(new Error("uncertain"));
  await expect(both.send(target, { text: "reply" })).rejects.toThrow("uncertain");
  expect(bsend).toHaveBeenCalledTimes(2);
});
it("both checkpoints independent child cursors and deduplicates proven Meta external IDs across sources", async () => {
  const f = fixtureHttp(), official = createInstagramOfficialChannel(f.options);
  const beeper = new FakeChannel("instagram"); beeper.accountId = self;
  const event = (await collect(official))[0];
  beeper.sync = async function* () { yield { ...event, external_id: "beeper-specific", conversation_external_id: "beeper-thread", sender: "alice" }; };
  const both = createInstagramBothChannel(beeper, official, { getPlatformMessageId: () => "m1" });
  const core = new ContactsCore({ path: ":memory:", registry: new ChannelRegistry([both]) });
  try {
    await syncChannel(core, both); await syncChannel(core, both);
    expect(core.conversations.search("")).toHaveLength(2);
    const cursor = core.syncStatus()[0].cursor!;
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString()).official).toBeTruthy();
  } finally { core.close(); }
});
it("daemon runs due maintenance, retains refresh errors safely and drains maintenance on close", async () => {
  const f = fixtureHttp(), channel = createInstagramOfficialChannel(f.options);
  const maintenance = vi.spyOn(channel, "maintenance").mockRejectedValueOnce(new Error("safe refresh failure"));
  const registry = new ChannelRegistry([channel]);
  const core = new ContactsCore({ path: ":memory:", registry });
  const records = vi.spyOn(core, "recordSync");
  const daemon = await startDaemon(core, registry, { port: 0, token: "offline", intervals: { instagram: 10 } });
  try {
    await expect.poll(() => records.mock.calls.some(args => args[3]?.includes("safe refresh failure"))).toBe(true);
    await expect.poll(() => core.syncStatus()[0]?.last_ok_at).toBeTruthy();
    expect(maintenance.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally { await daemon.close(); core.close(); }
});
it("rechecks the reply window after draft approval delay and preserves the draft on refusal", async () => {
  let now = clock();
  const f = fixtureHttp(), { core, registry } = await createContactsSystem({ env, path: ":memory:", clock: () => now, adapters: { instagramOfficial: { fetch: f.http } } });
  try {
    await syncChannel(core, registry.get("instagram"));
    const p = core.identity.create({ display_name: "Fixture" }), h = core.handles.ensure("instagram", self, target.handle);
    core.handles.link(h.id, p.id, "owner", "test", "exact ID");
    const draft = await core.outbox.send({ person_id: p.id, channel: "instagram", text: "Reply", created_by: "agent" });
    now = new Date("2026-10-13T10:00:00Z");
    await expect(core.outbox.approve(draft.id, "owner", "test")).rejects.toThrow("window");
    expect(core.outbox.get(draft.id).status).toBe("draft");
    expect(f.calls.some(c => c.init.method === "POST")).toBe(false);
  } finally { core.close(); }
});
it("uses persisted webhook inbound evidence when the latest 20 contain only outbound messages", async () => {
  const f = fixtureHttp(Array.from({ length: 20 }, (_, i) => message(`out-${i}`, "2026-10-12T11:00:00Z", true)));
  const c = createInstagramOfficialChannel({ ...f.options, getLastInboundAt: () => "2026-10-12T10:00:00Z" });
  await c.send(target, { text: "Valid reply" });
  expect(f.calls.at(-1)?.init.method).toBe("POST");
});
it("does not retry an uncertain send or expose token-bearing fetch diagnostics", async () => {
  const f = fixtureHttp(); let writes = 0;
  const http: typeof fetch = async (input, init) => {
    if (init?.method === "POST") { writes++; throw new Error("https://graph.instagram.com?access_token=SECRET"); }
    return f.http(input, init);
  };
  await expect(createInstagramOfficialChannel({ ...f.options, fetch: http }).send(target, { text: "Reply" })).rejects.toThrow("reconcile");
  expect(writes).toBe(1);
});
it("refuses malformed stored inbound evidence, future activity and broken pagination", async () => {
  const f = fixtureHttp([message("out", undefined, true)]);
  for (const at of ["not-a-date", "2026-10-13T12:00:00Z"]) {
    const channel = createInstagramOfficialChannel({ ...f.options, getLastInboundAt: () => at });
    await expect(channel.send(target, { text: "blocked" })).rejects.toThrow("window");
  }
  const channel = createInstagramOfficialChannel({ ...f.options, fetch: async () => new Response(JSON.stringify({ data: [conversation], paging: { next: "https://untrusted.invalid" } })) });
  await expect(collect(channel)).rejects.toThrow("pagination");
  expect(f.calls.some(c => c.init.method === "POST")).toBe(false);
});

it("treats the template's empty IG_USER_ID as omitted and keeps a nonempty logical account", async () => {
  const f = fixtureHttp();
  const registry = await configuredChannels({ ...env, IG_USER_ID: "" }, { instagramOfficial: { fetch: f.http } });
  const channel = registry.get("instagram");
  expect(channel.accountId).toBe("official");
  for await (const event of channel.sync()) expect(event.account_id).toBe("official");
});
