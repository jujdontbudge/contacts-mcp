import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ContactsCore } from "../src/core/index.js";
import { FakeChannel } from "../src/channels/fake.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { startSyncLoops, syncChannel, syncChannels } from "../src/daemon.js";
import type { Channel, IngestEvent } from "../src/channels/channel.js";
import { createInstagramBothChannel } from "../src/channels/instagram-transport.js";
import type { InstagramOfficialChannel } from "../src/channels/instagram-official.js";

const event: IngestEvent = { channel: "email", account_id: "default", external_id: "m", conversation_external_id: "thread", sender: "alice@example.com", direction: "in", sent_at: "2026-10-12T12:00:00Z", text: "" };
it("serializes syncs across separate SQLite connections and safely replays after a failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contacts-sync-")), path = join(dir, "test.db");
  const a = new ContactsCore({ path }), b = new ContactsCore({ path });
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let firstCalls = 0, secondCalls = 0;
  const one = new FakeChannel("email"), two = new FakeChannel("email");
  one.sync = async function* () { firstCalls++; enter(); await blocked; yield event; throw new Error("interrupted"); };
  two.sync = async function* (cursor) { secondCalls++; expect(cursor).toBe("m"); yield { ...event, external_id: "m2" }; };
  const first = syncChannel(a, one).catch(error => error);
  try {
    await entered;
    await syncChannel(b, two);
    expect(secondCalls).toBe(0);
    release();
    expect(await first).toMatchObject({ message: "interrupted" });
    expect(a.syncStatus()[0]).toMatchObject({ last_ok_at: null, last_error: "interrupted", cursor: "m" });
    await syncChannel(b, two);
    expect(secondCalls).toBe(1);
    expect(firstCalls).toBe(1);
    expect(b.conversations.search("", undefined, "email")).toHaveLength(2);
    expect(b.syncStatus()[0]).toMatchObject({ last_error: null, cursor: "m2" });
  } finally { release(); await first; a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps polling/ingesting when maintenance fails, and does not report false success", async () => {
  const fake: Channel = Object.assign(new FakeChannel("email"), { maintenance: async () => { throw new Error("refresh failed"); } });
  (fake as FakeChannel).events = [event];
  const registry = new ChannelRegistry([fake]), core = new ContactsCore({ path: ":memory:", registry });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const loops = startSyncLoops(core, registry);
  try {
    await expect.poll(() => core.conversations.search("").length).toBe(1);
    expect(core.syncStatus()[0]).toMatchObject({ last_ok_at: null, last_error: expect.stringContaining("refresh failed") });
  } finally { await loops.close(); core.close(); errors.mockRestore(); }
});

it("one failed channel does not stop another channel's sync or live listener", async () => {
  const failed = new FakeChannel("imessage"), healthy = new FakeChannel("email");
  failed.sync = async function* () { throw new Error("iMessage offline"); };
  healthy.events = [event];
  let live!: (e: IngestEvent) => void, stopped = false;
  const channel: Channel = Object.assign(healthy, { live: (callback: (e: IngestEvent) => void) => { live = callback; return () => { stopped = true; }; } });
  const registry = new ChannelRegistry([failed, channel]), core = new ContactsCore({ path: ":memory:", registry });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {}), loops = startSyncLoops(core, registry);
  try {
    await expect.poll(() => core.syncStatus().find(s => s.channel === "email")?.last_ok_at).toBeTruthy();
    expect(core.syncStatus().find(s => s.channel === "imessage")?.last_error).toContain("offline");
    live({ ...event, external_id: "live", text: "unicode 🦉" });
    expect(core.conversations.search("🦉")).toHaveLength(1);
  } finally { await loops.close(); core.close(); errors.mockRestore(); }
  expect(stopped).toBe(true);
});

it("sync rejects foreign channel/account events without advancing its cursor", async () => {
  const fake = new FakeChannel("email"), core = new ContactsCore({ path: ":memory:" });
  fake.events = [{ ...event, account_id: "foreign" }];
  try {
    await expect(syncChannel(core, fake)).rejects.toThrow("account");
    expect(core.conversations.list()).toHaveLength(0);
    expect(core.syncStatus()[0].cursor).toBeNull();
  } finally { core.close(); }
});

it("combined Instagram sync still runs official after a Beeper failure and saves its own checkpoint", async () => {
  const beeper = new FakeChannel("instagram"); beeper.accountId = "ig";
  beeper.sync = async function* () { throw new Error("Desktop offline"); };
  const official = Object.assign(new FakeChannel("instagram"), { accountId: "ig", resolveUserId: async () => "self", refreshAccessToken: async () => {}, handleWebhook: async () => {}, getCursor: () => "official-progress" }) as InstagramOfficialChannel;
  official.sync = async function* () { yield { ...event, channel: "instagram", account_id: "ig", sender: "alice" }; };
  const combined = createInstagramBothChannel(beeper, official), core = new ContactsCore({ path: ":memory:", registry: new ChannelRegistry([combined]) });
  try {
    await expect(syncChannel(core, combined)).rejects.toThrow("Desktop offline");
    expect(core.conversations.search("")).toHaveLength(1);
    const saved = JSON.parse(Buffer.from(core.syncStatus()[0].cursor!, "base64url").toString());
    expect(saved).toMatchObject({ version: 1, official: "official-progress" });
    expect(core.syncStatus()[0].last_ok_at).toBeNull();
  } finally { core.close(); }
});
it("the one-shot multi-channel sync still runs healthy channels and reports failures", async () => {
  const failed = new FakeChannel("imessage"), healthy = new FakeChannel("email");
  failed.sync = async function* () { throw new Error("iMessage offline"); };
  healthy.events = [event];
  const core = new ContactsCore({ path: ":memory:" });
  try {
    await expect(syncChannels(core, [failed, healthy])).rejects.toThrow("iMessage offline");
    expect(core.conversations.search("")).toHaveLength(1);
    expect(core.syncStatus().find(s => s.channel === "email")?.last_ok_at).toBeTruthy();
  } finally { core.close(); }
});
it("records account discovery failures instead of leaving a false healthy sync status", async () => {
  const fake: Channel = Object.assign(new FakeChannel("instagram"), { accountId: "ig", resolveAccountId: async () => { throw new Error("account disconnected"); } });
  const core = new ContactsCore({ path: ":memory:" });
  try {
    await expect(syncChannel(core, fake)).rejects.toThrow("account disconnected");
    expect(core.syncStatus()[0]).toMatchObject({ channel: "instagram", account_id: "ig", last_ok_at: null, last_error: "account disconnected" });
  } finally { core.close(); }
});
it("recovers an expired lease and prevents its old owner from writing a stale cursor/status", async () => {
  const core = new ContactsCore({ path: ":memory:" }), one = new FakeChannel("email"), two = new FakeChannel("email");
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  one.sync = async function* () { enter(); await blocked; yield { ...event, external_id: "stale" }; };
  two.events = [{ ...event, external_id: "healthy" }];
  const first = syncChannel(core, one).catch(error => error);
  try {
    await entered;
    core.store.run("UPDATE sync_leases SET expires_at=0");
    await syncChannel(core, two);
    release();
    expect(await first).toMatchObject({ message: expect.stringContaining("lease expired") });
    expect(core.syncStatus()[0]).toMatchObject({ cursor: "healthy", last_error: null });
    expect(core.conversations.search("").map(message => message.external_id)).toEqual(["healthy"]);
  } finally { release(); await first; core.close(); }
});
