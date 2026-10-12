import { afterEach, expect, it, vi } from "vitest";
import { ContactsCore } from "../src/core/index.js";
import { FakeChannel } from "../src/channels/fake.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import type { ChannelId, IngestEvent } from "../src/channels/channel.js";
import { tools } from "../src/mcp/tools.js";
import { normalizeHandle } from "../src/channels/channel.js";

const opened: ContactsCore[] = [];
afterEach(() => opened.splice(0).forEach(core => core.close()));
function setup(channel: ChannelId = "imessage") {
  const fake = new FakeChannel(channel);
  const clock = { now: new Date("2026-10-12T12:00:00Z") };
  const core = new ContactsCore({ path: ":memory:", registry: new ChannelRegistry([fake]), clock: () => clock.now });
  opened.push(core);
  const person = core.identity.create({ display_name: "Alice" });
  const handle = core.handles.add({ channel, value: channel === "imessage" ? "+13125550123" : channel === "email" ? "alice@example.com" : "alice", person_id: person.id, actor: "owner", reason: "Verified" });
  const event = (changes: Partial<IngestEvent> = {}): IngestEvent => ({ channel, account_id: "default", external_id: "incoming", conversation_external_id: "thread", direction: "in", sender: handle.value_raw, participants: [handle.value_raw], text: "hello", sent_at: clock.now.toISOString(), ...changes });
  const send = (text = "test 🦉") => core.outbox.send({ handle_id: handle.id, text, created_by: "agent", authorized_by: "owner", reason: "Offline test" });
  fake.send = vi.fn(async () => { throw new Error("send uncertain; reconcile before retrying"); });
  return { core, fake, clock, person, handle, event, send };
}

it("deactivates a standing rule by ID, audits the first actor, and makes later sends drafts", async () => {
  const { core, person, handle } = setup();
  const t = tools(core) as ReturnType<typeof tools> & Record<string, any>;
  const rule = core.authorization.add({ scope: "person", value: person.id, channels: ["imessage"], created_by: "owner" });
  expect(t.remove_send_rule).toBeDefined();
  const removed = t.remove_send_rule.call(t.remove_send_rule.schema.parse({ rule_id: rule.id, actor: "owner" }));
  expect(removed).toMatchObject({ id: rule.id, active: 0, removed_by: "owner", removed_at: core.store.now() });
  expect(t.remove_send_rule.call({ rule_id: rule.id, actor: "another" })).toEqual(removed);
  expect(() => t.remove_send_rule.call({ rule_id: "missing", actor: "owner" })).toThrow("Send rule not found");
  expect(t.remove_send_rule.schema.safeParse({ rule_id: rule.id, actor: " " }).success).toBe(false);
  expect(await core.outbox.send({ handle_id: handle.id, text: "hello", created_by: "agent" })).toMatchObject({ status: "draft" });
});

it.each(["imessage", "instagram"] as const)("reconciles a failed %s send in an existing conversation, preserving audit evidence and never resending", async channel => {
  const { core, fake, clock, event, send } = setup(channel);
  const incoming = core.ingest(event());
  const outbox = await send();
  expect(outbox.status).toBe("failed");
  clock.now = new Date(clock.now.getTime() + 5 * 60000);
  const sent = core.ingest(event({ external_id: "outgoing", direction: "out", sender: "owner@example.com", text: outbox.payload.text }));
  expect(core.outbox.get(outbox.id)).toMatchObject({ status: "sent", conversation_id: incoming.conversation_id, sent_message_id: sent.id, error: outbox.error, reconciled_at: clock.now.toISOString() });
  core.ingest(event({ external_id: "outgoing", direction: "out", sender: "owner@example.com", text: outbox.payload.text }));
  expect(fake.send).toHaveBeenCalledTimes(1);
  await expect(core.outbox.approve(outbox.id, "owner", "retry")).rejects.toThrow("Only draft");
});

it("reconciles new direct chats by exact recipient handle/account and uses decision time for old drafts", async () => {
  const { core, clock, handle, event } = setup();
  const draft = await core.outbox.send({ handle_id: handle.id, text: "same", created_by: "agent" });
  clock.now = new Date("2026-10-13T12:00:00Z");
  await core.outbox.approve(draft.id, "owner", "Approved");
  const sent = core.ingest(event({ external_id: "new-send", conversation_external_id: "new-chat", direction: "out", sender: "owner@example.com", text: "same", sent_at: "2026-10-13T12:09:59Z" }));
  expect(core.outbox.get(draft.id)).toMatchObject({ status: "sent", sent_message_id: sent.id, conversation_id: sent.conversation_id });
});

it.each(["incoming", "text", "account", "conversation", "old", "late", "pending", "failed-provider", "claimed"])("does not reconcile an unsafe %s match", async mismatch => {
  const { core, event, send } = setup("instagram");
  core.ingest(event());
  const outbox = await send();
  const changes: Partial<IngestEvent> = { external_id: "copy", direction: "out", sender: "owner", text: outbox.payload.text };
  if (mismatch === "incoming") changes.direction = "in";
  if (mismatch === "text") changes.text += " ";
  if (mismatch === "account") changes.account_id = "other";
  if (mismatch === "conversation") changes.conversation_external_id = "other";
  if (mismatch === "old") changes.sent_at = "2026-10-12T11:59:00Z";
  if (mismatch === "late") changes.sent_at = "2026-10-12T12:10:01Z";
  if (mismatch === "pending" || mismatch === "failed-provider") changes.raw = { message: { sendStatus: { status: mismatch === "pending" ? "PENDING" : "FAIL_PERMANENT" } } };
  if (mismatch === "claimed") {
    const sent = core.ingest(event(changes));
    core.store.run("UPDATE outbox SET status='sent',sent_message_id=? WHERE id=?", sent.id, outbox.id);
    const second = await send();
    core.ingest(event(changes));
    expect(core.outbox.get(second.id).status).toBe("failed");
  } else {
    core.ingest(event(changes));
    expect(core.outbox.get(outbox.id).status).toBe("failed");
  }
});

it("does not assign one outgoing copy to ambiguous repeated sends or new groups", async () => {
  const { core, event, send } = setup();
  const one = await send(), two = await send();
  core.ingest(event({ external_id: "group-copy", direction: "out", sender: "owner@example.com", kind: "group", text: one.payload.text }));
  core.ingest(event({ external_id: "direct-copy", direction: "out", sender: "owner@example.com", text: one.payload.text }));
  expect(core.outbox.get(one.id).status).toBe("failed");
  expect(core.outbox.get(two.id).status).toBe("failed");
});

it("refuses approval after a recipient handle value changes, and does not retarget a new-chat draft", async () => {
  const { core, handle, event, fake } = setup();
  const draft = await core.outbox.send({ handle_id: handle.id, text: "draft", created_by: "agent" });
  core.handles.change(handle.id, { value: "+13125550124", actor: "owner", reason: "Correction" });
  await expect(core.outbox.approve(draft.id, "owner", "Approved")).rejects.toThrow("changed");
  expect(fake.send).not.toHaveBeenCalled();
  const second = await core.outbox.send({ handle_id: handle.id, text: "second", created_by: "agent" });
  core.ingest(event({ sender: "+13125550124", participants: ["+13125550124"] }));
  let conversationAtSend: string | undefined;
  fake.send = vi.fn(async target => { conversationAtSend = target.conversationExternalId; return { externalId: "confirmed", conversationExternalId: target.conversationExternalId ?? "new" }; });
  await core.outbox.approve(second.id, "owner", "Approved");
  expect(conversationAtSend).toBeUndefined();
});

it("rejects cross-account external ID collisions without moving messages or copying participants", () => {
  const { core, event } = setup();
  const first = core.ingest(event());
  expect(() => core.ingest(event({ account_id: "other", conversation_external_id: "foreign", sender: "+13125550124" }))).toThrow("account");
  expect(core.conversations.detail(first.conversation_id).messages[0].id).toBe(first.id);
  expect(core.conversations.list()).toHaveLength(1);
});

it("requires email_to to include the explicitly selected handle and rejects reply IDs from another thread", async () => {
  const { core, handle, event, fake } = setup("email");
  await expect(core.outbox.send({ handle_id: handle.id, text: "hello", email_to: ["bob@example.com"], created_by: "agent" })).rejects.toThrow("selected handle");
  const a = core.ingest(event());
  const b = core.ingest(event({ external_id: "foreign", conversation_external_id: "other", sender: "bob@example.com", participants: ["bob@example.com"] }));
  await expect(core.outbox.send({ conversation_id: a.conversation_id, text: "hello", reply_to_external_id: b.external_id, created_by: "agent" })).rejects.toThrow("Reply message");
  expect(fake.send).not.toHaveBeenCalled();
});

it("bounds conversation tool output and resolver raw metadata on long threads", () => {
  const { core, person, event } = setup();
  for (let i = 0; i < 120; i++) core.ingest(event({ external_id: `m${i}`, sent_at: new Date(Date.parse("2026-10-12T10:00:00Z") + i * 1000).toISOString(), raw: { private: "payload" } }));
  const t = tools(core), conversation_id = core.conversations.list()[0].id;
  const result = t.get_conversation.call(t.get_conversation.schema.parse({ conversation_id }));
  expect(result.messages).toHaveLength(100);
  expect(result.messages[0].external_id).toBe("m20");
  expect(result).toMatchObject({ total_messages: 120, next_offset: 100 });
  const older = t.get_conversation.call(t.get_conversation.schema.parse({ conversation_id, offset: 100 }));
  expect(older.messages).toHaveLength(20);
  expect(older.messages[0].external_id).toBe("m0");
  expect(older).toMatchObject({ next_offset: null });
  expect(JSON.stringify(t.find_person.call({ query: person.display_name }))).not.toContain('"raw"');
});
it("never downgrades a known group into an implicit direct target", async () => {
  const { core, event, handle } = setup();
  const group = core.ingest(event({ kind: "group" }));
  core.ingest(event({ external_id: "next", kind: "direct" }));
  const draft = await core.outbox.send({ handle_id: handle.id, text: "hi", created_by: "agent" });
  expect(core.conversations.get(group.conversation_id).kind).toBe("group");
  expect(draft.conversation_id).toBeNull();
});
it("does not resolve colliding email/username punctuation or opaque ID case as exact identity", () => {
  const { core, handle, person } = setup("email");
  core.handles.change(handle.id, { value: "alice.smith@example.com", actor: "owner", reason: "Verified" });
  expect(core.resolver.find("alice_smith@example.com").sendable).toBe(false);
  expect(core.resolver.find("ALICE.SMITH@EXAMPLE.COM").person_id).toBe(person.id);
  core.handles.add({ channel: "tiktok", value: "tiktok:user:ABC", person_id: person.id, actor: "owner", reason: "Verified" });
  expect(core.resolver.find("tiktok:user:abc").sendable).toBe(false);
});
it("strictly normalizes phone inputs without extracting numbers from arbitrary text or extensions", () => {
  expect(() => normalizeHandle("imessage", "call Alice at +13125550123")).toThrow("phone");
  expect(() => normalizeHandle("imessage", "+13125550123 ext 456")).toThrow("phone");
  expect(normalizeHandle("imessage", "13125550123@example.com")).toBe("13125550123@example.com");
  expect(normalizeHandle("imessage", "(312) 555-0123")).toBe("+13125550123");
});
it("handles large identity alias lists without overflowing the JS argument stack", () => {
  const { core, person } = setup();
  core.identity.update(person.id, { aliases: Array.from({ length: 70000 }, (_, i) => `alias${i}`) });
  expect(core.resolver.find("Alice").person_id).toBe(person.id);
});
it("records the matching standing rule even when the caller supplies its own reason", async () => {
  const { core, handle, person } = setup();
  const rule = core.authorization.add({ scope: "person", value: person.id, channels: ["imessage"], created_by: "owner" });
  const result = await core.outbox.send({ handle_id: handle.id, text: "hi", reason: "followup", created_by: "agent" });
  expect(result.reason).toContain(rule.id);
  expect(result.reason).toContain("followup");
});
it("reconciles an outgoing live event that arrived before the adapter returned an uncertain error", async () => {
  const { core, fake, event, send } = setup();
  fake.send = vi.fn(async (_target, content) => {
    core.ingest(event({ external_id: "racing-live", direction: "out", sender: "owner@example.com", text: content.text }));
    throw new Error("send uncertain");
  });
  const result = await send();
  expect(result).toMatchObject({ status: "sent", error: "Error: send uncertain", reconciled_at: core.store.now() });
  expect(result.target.conversation_id).toBe(result.conversation_id);
  expect(fake.send).toHaveBeenCalledTimes(1);
});
it("never reconciles against an identical outgoing message already stored before the attempt", async () => {
  const { core, event, send } = setup();
  core.ingest(event({ external_id: "old-copy", direction: "out", sender: "owner@example.com", text: "test 🦉" }));
  const result = await send();
  expect(result.status).toBe("failed");
});
it("a rule revoked between matching and reservation cannot authorize a send", async () => {
  const { core, person, handle, fake } = setup();
  const rule = core.authorization.add({ scope: "person", value: person.id, channels: ["imessage"], created_by: "owner" });
  const match = core.authorization.match.bind(core.authorization);
  vi.spyOn(core.authorization, "match").mockImplementation((...args) => {
    const selected = match(...args);
    core.authorization.remove(rule.id, "owner");
    return selected;
  });
  const result = await core.outbox.send({ handle_id: handle.id, text: "hi", created_by: "agent" });
  expect(result).toMatchObject({ status: "draft", authorized_by: null });
  expect(fake.send).not.toHaveBeenCalled();
});
it("rejects adapter confirmation reusing a previously stored outgoing ID and preserves sending for manual recovery", async () => {
  const { core, fake, event, send } = setup();
  core.ingest(event({ external_id: "previous", direction: "out", sender: "owner@example.com", text: "test 🦉" }));
  fake.send = vi.fn(async () => ({ externalId: "previous", conversationExternalId: "thread" }));
  await expect(send()).rejects.toThrow("stored before dispatch");
  expect(core.store.all<{ status: string }>("SELECT status FROM outbox")[0].status).toBe("sending");
  expect(fake.send).toHaveBeenCalledTimes(1);
});
it("refuses legacy handles whose raw value no longer agrees with safe normalization", async () => {
  const { core, handle, fake } = setup();
  core.store.run("UPDATE handles SET value_raw=? WHERE id=?", "+13125550123 ext 456", handle.id);
  await expect(core.outbox.send({ handle_id: handle.id, text: "hello", created_by: "agent", authorized_by: "owner", reason: "Offline" })).rejects.toThrow("normalization");
  expect(fake.send).not.toHaveBeenCalled();
});
