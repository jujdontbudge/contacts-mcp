import { describe, expect, it, vi } from "vitest";
import { createContactsSystem } from "../src/composition.js";
import { ContactsCore } from "../src/core/index.js";
import { tools } from "../src/mcp/tools.js";

it("disables only SideShift when its key is missing", async () => {
  const { core, registry } = await createContactsSystem({ path: ":memory:", env: { CONTACTS_CHANNELS: "sideshift,imessage" } });
  try {
    expect(registry.list().map(c => c.id)).toEqual(["imessage"]);
    expect(core.syncStatus().find(s => s.channel === "sideshift")).toMatchObject({ status: "disabled", disabled_reason: "Missing required env: SIDESHIFT_API_KEY" });
  } finally { core.close(); }
});
it("includes SideShift in the default business inbox through MCP", () => {
  const core = new ContactsCore({ path: ":memory:" });
  try {
    core.inbox.setCutoff("2026-10-01T00:00:00Z", "test");
    core.ingest({ channel: "sideshift", account_id: "default", external_id: "m", conversation_external_id: "support:c", sender: "Creator", direction: "in", sent_at: "2026-10-12T12:00:00Z", text: "Hi" });
    expect(tools(core).list_inbox.call({}).items).toHaveLength(1);
  } finally { core.close(); }
});

import { createSideShiftChannel, SideShiftError } from "../src/channels/sideshift.js";
import { syncChannel, DEFAULT_SYNC_INTERVALS } from "../src/daemon.js";
import type { IngestEvent, SendTarget } from "../src/channels/channel.js";
const clock = () => new Date("2026-10-12T12:00:00Z");
const support = { id: "support/1", chatType: "native", customerUserId: "CreatorCase", customerName: "Alice", customerUser: { name: "Alice", externalUserId: null } };
const dm = { id: "dm-1", chatType: "native", members: ["Company", "TeamMember", "CreatorCase"], participants: [{ id: "CreatorCase", name: "Alice" }] };
const message = (id: string, sender = "CreatorCase", text = "Hello", time = "2026-10-12T11:00:00Z") => ({ id, senderUserId: sender, content: text, createdAt: time, source: "native", senderName: sender === "CreatorCase" ? "Alice" : "Employer", futureField: true });
const page = (data: unknown[], nextCursor: string | null = null) => ({ data, nextCursor, hasMore: !!nextCursor });
function httpHarness() {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const reads = new Map<string, unknown>([
    ["/jobs", { data: [{ id: "job-1", companyId: "Company" }] }],
    ["/applicants", page([{ userId: "CreatorCase", name: "Alice", instagram: "@alice", tiktok: "https://www.tiktok.com/@alice", profileUrl: "https://app.sideshift.app/profile/alice", profileImageUrl: "https://cdn.example/photo", jobId: "job-1" }])],
    ["/support-channels", page([support])],
    ["/conversations", page([dm, { ...dm, id: support.id, kind: "support" }])],
    ["/support-channels/support%2F1/messages", page([message("s-in"), message("s-out", "Company", "Old reply", "2026-10-12T10:00:00Z")])],
    ["/conversations/dm-1/messages", page([message("dm-in"), message("dm-team", "TeamMember", "Team reply", "2026-10-12T10:30:00Z")])],
  ]);
  let uncertain = false;
  let delivered = true;
  let sendCount = 0;
  const http = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input)); const path = url.pathname.replace("/api/oauth/v1", "");
    calls.push({ url, init });
    if (init?.method === "POST") {
      sendCount++;
      const body = JSON.parse(String(init.body));
      const thread = path === "/applicants/message" ? "new-support" : path === "/messages" ? body.conversationId : "support/1";
      const route = path === "/messages" ? "/conversations/dm-1/messages" : `/support-channels/${encodeURIComponent(thread)}/messages`;
      const sent = message("sent-1", "Company", body.content ?? body.message, clock().toISOString());
      reads.set(route, page([...((reads.get(route) as { data: unknown[] })?.data ?? []), sent]));
      if (thread === "new-support") reads.set("/support-channels", page([support, { ...support, id: thread }]));
      if (uncertain) throw new Error("network failure containing offline-secret");
      const data = path === "/applicants/message" ? { success: true, supportChannelId: thread, messageIds: ["sent-1"] }
        : path === "/messages" ? { delivered, conversationId: thread, messageId: "sent-1", externalMessageId: null }
        : { delivered, channelId: thread, id: "sent-1", createdAt: clock().toISOString() };
      return Response.json({ data }, { status: 201 });
    }
    const key = path + (url.searchParams.get("cursor") ? `?cursor=${url.searchParams.get("cursor")}` : "");
    const data = reads.get(key);
    if (!data) throw new Error(`Unexpected read: ${key}`);
    return Response.json(data);
  }) as unknown as typeof fetch;
  return { http, reads, calls, get sendCount() { return sendCount; }, setUncertain: () => { uncertain = true; }, setUnconfirmed: () => { delivered = false; } };
}
async function collect(events: AsyncIterable<IngestEvent>) { const result = []; for await (const e of events) result.push(e); return result; }
const sendTarget: SendTarget = { person_id: "p", handle_id: "h", handle: "CreatorCase", channel: "sideshift", account_id: "default", conversationExternalId: "support:support/1", conversationKind: "direct" };
async function system(fake: ReturnType<typeof httpHarness>) {
  return createContactsSystem({ path: ":memory:", clock, env: { CONTACTS_CHANNELS: "sideshift", SIDESHIFT_API_KEY: "offline-secret" }, adapters: { sideshift: { fetch: fake.http } } });
}

describe("SideShift REST adapter (offline)", () => {
  it("syncs support and DM pages once, preserving IDs, profiles, directions and raw metadata", async () => {
    const fake = httpHarness();
    const { core, registry } = await system(fake);
    try {
      await syncChannel(core, registry.get("sideshift"));
      expect(core.conversations.list()).toHaveLength(2);
      expect(core.store.all("SELECT * FROM messages")).toHaveLength(4);
      const own = core.store.all<{ value_raw: string }>("SELECT h.value_raw FROM conversation_participants cp JOIN handles h ON h.id=cp.handle_id");
      expect(own.every(h => h.value_raw === "CreatorCase")).toBe(true);
      const handle = core.handles.unlinked().find(h => h.value_raw === "CreatorCase")!;
      expect(handle.profile).toMatchObject({ display_name: "Alice", profile_url: "https://app.sideshift.app/profile/alice", job_ids: ["job-1"], related_handles: [{ channel: "instagram", value: "alice" }, { channel: "tiktok", value: "alice" }] });
      expect(core.store.one("SELECT raw FROM messages WHERE direction='in'")).toMatchObject({ raw: { message: { futureField: true } } });
      expect(core.syncStatus().find(s => s.channel === "sideshift")).toMatchObject({ status: "enabled", last_error: null });
      expect(fake.calls.filter(c => c.init?.method === "POST")).toHaveLength(0);
      expect(DEFAULT_SYNC_INTERVALS.sideshift).toBe(120_000);
    } finally { core.close(); }
  });
  it("paginates all three lists and messages, persists tie IDs and resumes after restart", async () => {
    const fake = httpHarness();
    fake.reads.set("/applicants", page([], "a-next"));
    fake.reads.set("/applicants?cursor=a-next", page([{ userId: "Other", name: "Other" }]));
    fake.reads.set("/support-channels", page([], "s-next"));
    fake.reads.set("/support-channels?cursor=s-next", page([support]));
    fake.reads.set("/conversations", page([], "dm-next"));
    fake.reads.set("/conversations?cursor=dm-next", page([dm]));
    fake.reads.set("/conversations/dm-1/messages", page([message("newest", "CreatorCase", "Newest", "2026-10-12T11:30:00Z")], "m-next"));
    fake.reads.set("/conversations/dm-1/messages?cursor=m-next", page([message("older")]));
    const first = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: fake.http });
    const events = await collect(first.sync());
    expect(events.filter(e => e.conversation_external_id === "dm:dm-1").map(e => e.text)).toEqual(["Hello", "Newest"]);
    const saved = first.getCursor();
    fake.reads.set("/conversations/dm-1/messages", page([message("newest", "CreatorCase", "Newest", "2026-10-12T11:30:00Z"), message("tie", "CreatorCase", "Tie", "2026-10-12T11:30:00Z")]));
    const second = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: fake.http });
    expect((await collect(second.sync(saved))).map(e => e.text)).toEqual(["Tie"]);
    const profiles = []; for await (const p of second.syncProfiles!()) profiles.push(p);
    expect(profiles[0].value).toBe("Other");
    expect(fake.calls.some(c => c.url.searchParams.get("cursor") === "m-next")).toBe(true);
  });
  it("checkpoints completed threads only, and replays a failed ingestion/page", async () => {
    const fake = httpHarness();
    const adapter = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: fake.http });
    const checkpoints: string[] = [];
    const iterator = adapter.sync(undefined, c => checkpoints.push(c))[Symbol.asyncIterator]();
    const before = adapter.getCursor();
    await iterator.next();
    expect(JSON.parse(Buffer.from(adapter.getCursor(), "base64url").toString()).conversations).toEqual(JSON.parse(Buffer.from(before, "base64url").toString()).conversations);
    await iterator.return?.();
    expect(checkpoints).toEqual([]);
    fake.reads.set("/conversations/dm-1/messages", page([], "broken"));
    await expect(collect(adapter.sync(undefined, c => checkpoints.push(c)))).rejects.toThrow("transport_error");
    expect(checkpoints).toHaveLength(1);
    fake.reads.set("/conversations/dm-1/messages", page([message("recover")]));
    expect((await collect(adapter.sync(checkpoints[0]))).map(e => e.text)).toEqual(["Hello"]);
  });
  it("links only a stored exact SideShift external ID, keeping name/social matches as suggestions", async () => {
    const fake = httpHarness(); const { core, registry } = await system(fake);
    try {
      const alice = core.identity.create({ display_name: "Alice" });
      core.handles.add({ channel: "instagram", value: "@alice", person_id: alice.id, actor: "test", reason: "Verified Instagram" });
      await syncChannel(core, registry.get("sideshift"));
      const handle = core.handles.unlinked().find(h => h.value_raw === "CreatorCase")!;
      expect(handle.person_id).toBeNull();
      expect(core.handles.suggestions()).toEqual(expect.arrayContaining([expect.objectContaining({ handle_id: handle.id, person_id: alice.id, status: "pending" })]));
      core.identity.update(alice.id, { links: [{ system: "sideshift", external_id: "CreatorCase" }] });
      await syncChannel(core, registry.get("sideshift"));
      expect(core.handles.get(handle.id).person_id).toBe(alice.id);
      expect(core.conversations.list(alice.id)).toHaveLength(2);
      expect(core.handles.events(handle.id)).toEqual(expect.arrayContaining([expect.objectContaining({ action: "link", actor: "ingest" })]));
    } finally { core.close(); }
  });
  it.each(["support:support/1", "dm:dm-1"])("sends authorized replies to %s, reuses keys and dedupes the synced echo", async route => {
    const fake = httpHarness(); const { core, registry } = await system(fake);
    try {
      const alice = core.identity.create({ display_name: "Alice", links: [{ system: "sideshift", external_id: "CreatorCase" }] });
      await syncChannel(core, registry.get("sideshift"));
      const conversation = core.conversations.list(alice.id).find(c => c.external_id === route)!;
      const input = { person_id: alice.id, channel: "sideshift" as const, conversation_id: conversation.id, text: "Authorized reply", created_by: "test", authorized_by: "owner", reason: "Offline test", idempotency_key: "reply-key" };
      const sent = await core.outbox.send(input);
      expect(sent.status).toBe("sent");
      expect((await core.outbox.send({ ...input, text: "Changed" })).already_used).toBe(true);
      expect(fake.sendCount).toBe(1);
      const call = fake.calls.find(c => c.init?.method === "POST")!;
      expect(call.init?.headers).toMatchObject({ "Idempotency-Key": sent.id, "x-api-key": "offline-secret" });
      expect(JSON.parse(String(call.init?.body))).toEqual({ content: "Authorized reply", ...(route.startsWith("dm:") ? { conversationId: "dm-1" } : {}) });
      await syncChannel(core, registry.get("sideshift"));
      expect(core.store.all("SELECT * FROM messages WHERE text='Authorized reply'")).toHaveLength(1);
      expect(core.store.one("SELECT id FROM messages WHERE text='Authorized reply'")).toEqual({ id: sent.sent_message_id });
    } finally { core.close(); }
  });
  it("keeps sends as drafts without authorization and starts an applicant support chat only on approval", async () => {
    const fake = httpHarness(); const { core, registry } = await system(fake);
    try {
      const alice = core.identity.create({ display_name: "Alice" });
      core.handles.add({ channel: "sideshift", value: "CreatorCase", person_id: alice.id, actor: "test", reason: "Exact ID" });
      const draft = await core.outbox.send({ person_id: alice.id, channel: "sideshift", text: "Welcome", metadata: { sideshift_job_id: "job-1" }, created_by: "test", idempotency_key: "new-key" });
      expect(draft.status).toBe("draft"); expect(fake.sendCount).toBe(0);
      const sent = await core.outbox.approve(draft.id, "owner", "Offline approval");
      expect(sent.status).toBe("sent");
      const call = fake.calls.find(c => c.init?.method === "POST")!;
      expect(call.url.pathname).toBe("/api/oauth/v1/applicants/message");
      expect(JSON.parse(String(call.init?.body))).toEqual({ applicantId: "CreatorCase", jobId: "job-1", message: "Welcome", includeJobLink: false });
      expect((await core.outbox.send({ person_id: alice.id, channel: "sideshift", text: "Welcome", created_by: "test", idempotency_key: "new-key" })).already_used).toBe(true);
      await syncChannel(core, registry.get("sideshift"));
      expect(core.store.all("SELECT * FROM messages WHERE text='Welcome'")).toHaveLength(1);
      expect(core.outbox.get(sent.id).sent_message_id).toBe(sent.sent_message_id);
    } finally { core.close(); }
  });
  it.each([false, true])("reconciles an uncertain send (new applicant=%s) without redispatch", async applicant => {
    const fake = httpHarness(); const { core, registry } = await system(fake);
    try {
      const alice = core.identity.create({ display_name: "Alice", links: [{ system: "sideshift", external_id: "CreatorCase" }] });
      if (applicant) core.handles.add({ channel: "sideshift", value: "CreatorCase", person_id: alice.id, actor: "test", reason: "Exact ID" });
      else await syncChannel(core, registry.get("sideshift"));
      fake.setUncertain();
      const input = { person_id: alice.id, channel: "sideshift" as const, ...(applicant ? { metadata: { sideshift_job_id: "job-1" } } : { conversation_id: core.conversations.list(alice.id).find(c => c.external_id.startsWith("support:"))!.id }), text: "Uncertain reply", created_by: "test", authorized_by: "owner", reason: "Offline test", idempotency_key: "uncertain-key" };
      const failed = await core.outbox.send(input);
      expect(failed.status).toBe("failed"); expect(failed.error).toContain("send outcome unknown"); expect(failed.error).not.toContain("offline-secret");
      expect((await core.outbox.send(input)).already_used).toBe(true); expect(fake.sendCount).toBe(1);
      await syncChannel(core, registry.get("sideshift"));
      expect(core.outbox.get(failed.id)).toMatchObject({ status: "sent", reconciled_at: clock().toISOString() });
      expect(fake.sendCount).toBe(1);
    } finally { core.close(); }
  });
  it("runs the inbox claim/send/mark flow with standing authorization unchanged", async () => {
    const fake = httpHarness(); const { core, registry } = await system(fake);
    try {
      const alice = core.identity.create({ display_name: "Alice", links: [{ system: "sideshift", external_id: "CreatorCase" }] });
      await syncChannel(core, registry.get("sideshift")); core.inbox.setCutoff("2026-10-12T10:45:00Z", "test");
      const item = tools(core).list_inbox.call({}).items[0];
      const claim = core.inbox.claim({ message_ids: [item.id], actor: "automation" });
      const rule = core.authorization.add({ scope: "person", value: alice.id, channels: ["sideshift"], created_by: "owner" });
      const sent = await core.outbox.send({ person_id: alice.id, conversation_id: item.conversation_id, text: "Thanks", created_by: "automation", inbox_message_id: item.id, claim_token: claim.claim_token, idempotency_key: `rule:${rule.id}:msg:${item.id}` });
      expect(sent.status).toBe("sent");
      const marked = core.inbox.mark({ message_id: item.id, claim_token: claim.claim_token, outcome: "auto_replied", actor: "automation", note: "Replied", outbox_id: sent.id });
      expect(marked.outcome).toBe("auto_replied");
    } finally { core.close(); }
  });
  it("honors read 429/reset headers with bounded exponential backoff and proactively throttles", async () => {
    let time = clock().getTime(); const sleeps: number[] = []; let count = 0;
    const http = vi.fn(async () => {
      count++;
      if (count <= 2) return Response.json({ error: { code: "rate_limited", message: "offline-secret" } }, { status: 429, headers: { "Retry-After": "2", "X-RateLimit-Reset": String((time + 3000) / 1000), "X-RateLimit-Remaining": "0" } });
      if (count === 3) return Response.json({ data: [] }, { headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String((time + 5000) / 1000) } });
      return Response.json(page([]));
    }) as unknown as typeof fetch;
    const adapter = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: http, clock: () => new Date(time), random: () => 0, sleep: async ms => { sleeps.push(ms); time += ms; } });
    await collect(adapter.sync());
    expect(sleeps).toEqual([3000, 3000, 5000]);
    expect(http).toHaveBeenCalledTimes(5);
  });
  it("never retries a rate-limited POST and honors its backoff on the next request", async () => {
    let time = clock().getTime(); const sleeps: number[] = []; let count = 0;
    const http = vi.fn(async () => ++count === 1 ? Response.json({ error: { code: "rate_limited", message: "offline-secret", meta: { retryAfterSeconds: 7 } } }, { status: 429 }) : Response.json({ data: { delivered: true, id: "sent", channelId: "support/1" } })) as unknown as typeof fetch;
    const adapter = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: http, clock: () => new Date(time), random: () => 0, sleep: async ms => { sleeps.push(ms); time += ms; } });
    await expect(adapter.send(sendTarget, { text: "Hi" })).rejects.toMatchObject({ code: "rate_limited", uncertain: false });
    expect(count).toBe(1);
    await adapter.send(sendTarget, { text: "Another logical message" });
    expect(sleeps).toEqual([7000]);
  });
  it.each([401, 403, 404, 500, 502])("reports safe HTTP %s errors without reflecting provider text or credentials", async status => {
    const adapter = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: (async () => Response.json({ error: { code: "internal", message: "offline-secret", requestId: "offline-secret" } }, { status })) as typeof fetch });
    await expect(adapter.send(sendTarget, { text: "Hi" })).rejects.toMatchObject({ name: "SideShiftError", uncertain: status >= 500 });
    try { await adapter.send(sendTarget, { text: "Hi" }); } catch (e) { expect(String(e)).not.toContain("offline-secret"); }
  });
  it("does not confirm provider delivery=false", async () => {
    const fake = httpHarness(); fake.setUnconfirmed();
    const adapter = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: fake.http });
    await expect(adapter.send({ ...sendTarget, conversationExternalId: "dm:dm-1" }, { text: "Hi" })).rejects.toMatchObject({ code: "delivery_unconfirmed", uncertain: true });
    expect(fake.sendCount).toBe(1);
  });
  it.each(["broken", Buffer.from(JSON.stringify({ version: 1, accountId: "other", conversations: {} })).toString("base64url")])("rejects a corrupt/account-mismatched cursor before HTTP", async cursor => {
    const fake = httpHarness(); const adapter = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: fake.http });
    await expect(collect(adapter.sync(cursor))).rejects.toThrow("Invalid SideShift sync cursor"); expect(fake.calls).toHaveLength(0);
  });
  it("fails incomplete/repeated pagination without pretending success", async () => {
    const fake = httpHarness(); const adapter = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: fake.http });
    fake.reads.set("/support-channels", page([], "same")); fake.reads.set("/support-channels?cursor=same", page([], "same"));
    await expect(collect(adapter.sync())).rejects.toThrow("repeated pagination cursor");
    fake.reads.set("/support-channels", { data: [], hasMore: true });
    await expect(collect(adapter.sync())).rejects.toThrow("nextCursor");
  });
  it.each([
    [{ ...sendTarget, conversationExternalId: undefined }, { text: "Hi" }, "sideshift_job_id"],
    [sendTarget, { text: "Hi", attachments: [{ url: "https://example.com" }] }, "unsupported"],
    [{ ...sendTarget, conversationKind: "group" }, { text: "Hi" }, "group"],
    [{ ...sendTarget, account_id: "other" }, { text: "Hi" }, "mismatch"],
    [sendTarget, { text: "x".repeat(10001) }, "10000"],
  ])("refuses invalid routing/content before HTTP", async (target, content, error) => {
    const fake = httpHarness(); const adapter = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "offline-outbox-id", fetch: fake.http });
    await expect(adapter.send(target as SendTarget, content)).rejects.toThrow(error); expect(fake.calls).toHaveLength(0);
  });
});

it("bounds repeated GET rate limits and sanitizes non-JSON send responses", async () => {
  let time = clock().getTime(); const sleeps: number[] = [];
  const http = vi.fn(async () => Response.json({ error: { code: "rate_limited", message: "offline-secret" } }, { status: 429, headers: { "Retry-After": "1" } })) as unknown as typeof fetch;
  const adapter = createSideShiftChannel({ apiKey: "offline-secret", fetch: http, random: () => 0, clock: () => new Date(time), sleep: async ms => { sleeps.push(ms); time += ms; } });
  await expect(collect(adapter.sync())).rejects.toMatchObject({ code: "rate_limited" });
  expect(http).toHaveBeenCalledTimes(4); expect(sleeps).toEqual([1000, 2000, 4000]);
  const nonJson = createSideShiftChannel({ apiKey: "offline-secret", getOutboxId: () => "outbox-test", fetch: (async () => new Response("offline-secret", { status: 502 })) as typeof fetch });
  await expect(nonJson.send(sendTarget, { text: "Hi" })).rejects.toMatchObject({ code: "invalid_response", uncertain: true });
});
it("refuses sends without durable dispatch context", async () => {
  const fake = httpHarness(); const adapter = createSideShiftChannel({ apiKey: "offline-secret", fetch: fake.http });
  await expect(adapter.send(sendTarget, { text: "Hi" })).rejects.toThrow("active outbox dispatch ID"); expect(fake.calls).toHaveLength(0);
});
it("retains unresolved provider customer IDs and refuses unknown DM direction", async () => {
  const fake = httpHarness();
  fake.reads.set("/support-channels", page([{ ...support, customerUserId: null, customerUser: { externalUserId: "provider-peer", name: "Unknown" } }]));
  fake.reads.set("/conversations", page([]));
  fake.reads.set("/support-channels/support%2F1/messages", page([{ ...message("provider-in"), source: "live", senderUserId: null, senderExternalUserId: "provider-peer" }, message("own", "Company")]));
  const adapter = createSideShiftChannel({ apiKey: "offline-secret", fetch: fake.http });
  const events = await collect(adapter.sync());
  expect(events.find(e => e.direction === "in")).toMatchObject({ sender: "provider:provider-peer", participants: ["provider:provider-peer"] });
  fake.reads.set("/conversations", page([dm]));
  fake.reads.set("/conversations/dm-1/messages", page([{ ...message("unknown"), senderUserId: null, senderExternalUserId: null, sender: "A display name" }]));
  await expect(collect(adapter.sync())).rejects.toThrow("refusing to guess message direction");
});
it("rejects changed tenants before importing profiles and refuses conflicting exact identity", async () => {
  const fake = httpHarness(); const adapter = createSideShiftChannel({ apiKey: "offline-secret", fetch: fake.http });
  await collect(adapter.sync()); const saved = adapter.getCursor();
  fake.reads.set("/jobs", { data: [{ id: "job-2", companyId: "OtherCompany" }] });
  const iterator = adapter.syncProfiles!(saved)[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toThrow("tenant changed");
  const core = new ContactsCore({ path: ":memory:" });
  try {
    const a = core.identity.create({ display_name: "A" }); const b = core.identity.create({ display_name: "B", links: [{ system: "sideshift", external_id: "CreatorCase" }] });
    const handle = core.handles.add({ channel: "sideshift", value: "CreatorCase", person_id: a.id, actor: "test", reason: "Existing verified link" });
    expect(() => core.handles.ingestProfile({ channel: "sideshift", account_id: "default", value: "CreatorCase", display_name: "B" })).toThrow("conflicts");
    expect(core.handles.get(handle.id)).toMatchObject({ person_id: a.id, profile: null }); expect(b.id).not.toBe(a.id);
  } finally { core.close(); }
});
it("does not mistake every member for the employer when counterpart profiles are absent", async () => {
  const fake = httpHarness(); fake.reads.set("/conversations", page([{ ...dm, participants: [] }]));
  const adapter = createSideShiftChannel({ apiKey: "offline-secret", fetch: fake.http });
  await expect(collect(adapter.sync())).rejects.toMatchObject({ code: "participant_identity_unresolved" });
});
