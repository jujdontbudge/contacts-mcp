import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContactsCore } from "../src/core/index.js";
import { FakeChannel } from "../src/channels/fake.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import type { IngestEvent } from "../src/channels/channel.js";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "inbox-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "contacts.db");
  let now = new Date("2026-10-12T12:00:00.000Z");
  const fake = new FakeChannel("email");
  const open = () => {
    const core = new ContactsCore({ path, registry: new ChannelRegistry([fake]), clock: () => now });
    cleanup.push(() => { if (core.store.db.open) core.close(); });
    return core;
  };
  const core = open();
  const person = core.identity.create({ display_name: "Alice", tags: ["creator"] });
  const handle = core.handles.add({ channel: "email", value: "alice@example.com", person_id: person.id, actor: "owner", reason: "Verified" });
  const ingest = (changes: Partial<IngestEvent> = {}) => core.ingest({ channel: "email", account_id: "default", external_id: "in1", conversation_external_id: "thread1", direction: "in", sender: handle.value_raw, text: "Hello", sent_at: now.toISOString(), ...changes });
  core.inbox.setCutoff("2026-10-12T11:59:59.000Z", "owner");
  const m = ingest();
  const request = { person_id: person.id, conversation_id: m.conversation_id, text: "Reply", created_by: "agent", authorized_by: "owner", reason: "Rule applies", idempotency_key: `rule:r1:msg:${m.id}` };
  return { core, open, fake, person, m, ingest, request, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
it("claims sets atomically across connections, expires leases and fences stale tokens", async () => {
  const { core, open, m, ingest, advance, request, fake } = setup();
  const other = open();
  const m2 = ingest({ external_id: "in2" });
  const first = core.inbox.claim({ message_ids: [m.id], actor: "same-agent" });
  expect(() => other.inbox.claim({ message_ids: [m2.id, m.id], actor: "same-agent" })).toThrow("unavailable");
  expect(other.inbox.list().items.map(m => m.id)).toEqual([m2.id]);
  expect(other.store.one("SELECT outcome FROM inbox_handling WHERE message_id=?", m2.id)).toEqual({ outcome: "new" });
  advance(600_000);
  expect(other.inbox.list().items.map(m => m.id)).toContain(m.id);
  const second = other.inbox.claim({ message_ids: [m.id], actor: "same-agent" });
  expect(second.claim_token).not.toBe(first.claim_token);
  await expect(core.outbox.send({ ...request, inbox_message_id: m.id, claim_token: first.claim_token })).rejects.toThrow("superseded");
  expect(() => core.inbox.mark({ message_id: m.id, outcome: "ignored", actor: "agent", note: "stale", claim_token: first.claim_token })).toThrow("superseded");
  expect(fake.sent).toHaveLength(0);
});
it("disables inbox before cutoff, excludes cutoff ties/history and iMessage by default, supplies context", () => {
  const { core, m, ingest } = setup();
  ingest({ external_id: "old", sent_at: "2026-10-12T11:59:59.000Z" });
  const personal = ingest({ channel: "imessage", external_id: "personal", conversation_external_id: "phone", sender: "+13125550123" });
  const result = core.inbox.list();
  expect(result.items.map(m => m.id)).toEqual([m.id]);
  expect(result.items[0]).toMatchObject({ person: { name: "Alice", tags: ["creator"] }, state: { outcome: "new" } });
  expect(result.items[0].context).toHaveLength(2);
  expect(result.items[0]).not.toHaveProperty("raw");
  expect(core.inbox.list({ channels: ["imessage"] }).items[0].id).toBe(personal.id);
  core.inbox.setCutoff("2026-10-12T12:00:00.000Z", "owner");
  expect(core.inbox.list().items).toEqual([]);
  expect(() => core.inbox.claim({ message_ids: [m.id], actor: "agent" })).toThrow("unavailable");
  core.store.run("DELETE FROM inbox_config");
  expect(core.inbox.list()).toEqual({ cutoff: null, items: [] });
});
it("confirmed replies elsewhere close earlier new and claimed inbound, including late ingested replies", () => {
  const { core, m, ingest, advance } = setup();
  const m2 = ingest({ external_id: "in2" });
  core.inbox.claim({ message_ids: [m2.id], actor: "agent" });
  advance(1000);
  ingest({ direction: "out", external_id: "manual", sender: "owner@example.com" });
  expect(core.inbox.list().items).toEqual([]);
  expect(core.store.one("SELECT outcome FROM inbox_handling WHERE message_id=?", m.id)).toEqual({ outcome: "done" });
  expect(() => core.inbox.claim({ message_ids: [m2.id], actor: "agent" })).toThrow("unavailable");
  const late = ingest({ external_id: "late", sent_at: "2026-10-12T12:00:00.500Z" });
  expect(core.inbox.list().items).toEqual([]);
  expect(core.store.one("SELECT outcome FROM inbox_handling WHERE message_id=?", late.id)).toEqual({ outcome: "done" });
});
it("deduplicates concurrent sends and once-per-person keys across different messages and restarts", async () => {
  const { core, open, fake, person, request } = setup();
  const other = open();
  const key = `rule:r1:person:${person.id}`;
  const [a, b] = await Promise.all([core.outbox.send({ ...request, idempotency_key: key }), other.outbox.send({ ...request, idempotency_key: key, text: "Different" })]);
  expect(a.id).toBe(b.id);
  expect(b.already_used).toBe(true);
  expect(fake.sent).toHaveLength(1);
  core.close();
  const again = await open().outbox.send({ ...request, idempotency_key: key });
  expect(again.id).toBe(a.id);
  expect(again.status).toBe("sent");
  expect(fake.sent).toHaveLength(1);
});
it("retains crash reservation and reconciles keyed sending from sync without re-sending", async () => {
  const { core, open, fake, request, ingest, advance } = setup();
  const nativeSend = fake.send.bind(fake);
  fake.send = async (target, content) => {
    const sent = await nativeSend(target, content);
    return { ...sent, externalId: "in1" }; // Local persistence failure after provider mutation.
  };
  await expect(core.outbox.send(request)).rejects.toThrow("conflicts");
  const id = core.store.one<{ id: string }>("SELECT id FROM outbox")!.id;
  core.close();
  const restarted = open();
  expect(await restarted.outbox.send(request)).toMatchObject({ id, status: "sending", already_used: true });
  expect(fake.sent).toHaveLength(1);
  advance(1000);
  restarted.ingest({ channel: "email", account_id: "default", conversation_external_id: "thread1", external_id: fake.sent[0].externalId, direction: "out", sender: "owner@example.com", text: request.text, email_to: ["alice@example.com"], sent_at: "2026-10-12T12:00:01.000Z" });
  expect(await restarted.outbox.send(request)).toMatchObject({ id, status: "sent", already_used: true });
  expect(fake.sent).toHaveLength(1);
});
it("never resumes a draft left by a crash before dispatch", async () => {
  const { core, open, request, fake } = setup();
  const draft = await core.outbox.send({ ...request, authorized_by: undefined });
  core.close();
  expect(await open().outbox.send(request)).toMatchObject({ id: draft.id, status: "draft", already_used: true });
  expect(fake.sent).toHaveLength(0);
});
it("binds one reply per inbound across different keys and marks idempotently with audit", async () => {
  const { core, m, request, fake, advance } = setup();
  const claim = core.inbox.claim({ message_ids: [m.id], actor: "agent" });
  advance(1000);
  const result = await core.outbox.send({ ...request, inbox_message_id: m.id, claim_token: claim.claim_token });
  const duplicate = await core.outbox.send({ ...request, idempotency_key: "another-rule", inbox_message_id: m.id, claim_token: claim.claim_token });
  expect(duplicate).toMatchObject({ id: result.id, already_used: true });
  const mark = { message_id: m.id, outcome: "auto_replied" as const, actor: "agent", note: "Rule matched", rule: "r1", outbox_id: result.id, claim_token: claim.claim_token };
  expect(core.inbox.mark(mark)).toMatchObject({ outcome: "auto_replied", rule: "r1" });
  const count = core.store.all("SELECT * FROM inbox_events").length;
  expect(core.inbox.mark(mark).note).toBe("Rule matched");
  expect(core.store.all("SELECT * FROM inbox_events")).toHaveLength(count);
  expect(core.inbox.list().items).toEqual([]);
  expect(fake.sent).toHaveLength(1);
});
it("marks escalations exactly once and prevents conflicting finalizations", () => {
  const { core, m } = setup();
  const c = core.inbox.claim({ message_ids: [m.id], actor: "agent" });
  const mark = { message_id: m.id, outcome: "escalated" as const, actor: "agent", note: "Owner decision needed", claim_token: c.claim_token };
  expect(core.inbox.mark(mark)).toEqual(core.inbox.mark(mark));
  expect(() => core.inbox.mark({ ...mark, outcome: "ignored" })).toThrow();
  expect(core.inbox.list().items).toEqual([]);
});
