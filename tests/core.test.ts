import { afterEach, describe, expect, it } from "vitest";
import { ContactsCore } from "../src/core/index.js";
import { FakeChannel } from "../src/channels/fake.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import type { ChannelId, IngestEvent } from "../src/channels/channel.js";
const opened: ContactsCore[] = [];
afterEach(() => {
  opened.splice(0).forEach((c) => c.close());
});
function setup(id: ChannelId = "email", limit?: number) {
  const fake = new FakeChannel(id);
  const clock = { now: new Date("2026-10-12T12:00:00.000Z") };
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([fake]),
    clock: () => clock.now,
    rateLimits: limit === undefined ? {} : { [id]: limit },
  });
  opened.push(core);
  const person = core.identity.create({
    display_name: "Alice Smith",
    aliases: ["Ally"],
    tags: ["creator"],
    links: [{ system: "creator-crm", external_id: "7" }],
  });
  const handle = core.handles.add({
    channel: id,
    value:
      id === "email"
        ? "ALICE@example.com"
        : id === "imessage"
          ? "(312) 555-0123"
          : "@Alice",
    person_id: person.id,
    actor: "owner",
    reason: "Confirmed contact",
  });
  const event = (changes: Partial<IngestEvent> = {}): IngestEvent => ({
    channel: id,
    account_id: "default",
    external_id: "incoming1",
    conversation_external_id: "thread1",
    direction: "in",
    sender: handle.value_raw,
    text: "hello",
    sent_at: clock.now.toISOString(),
    ...changes,
  });
  return { core, fake, clock, person, handle, event };
}
describe("identity and resolution", () => {
  it("resolves unique exact names, aliases, email handles and external links", () => {
    const { core, person } = setup();
    for (const q of [
      "Alice Smith",
      "ALLY",
      "alice@EXAMPLE.COM",
      "creator-crm:7",
    ]) {
      const r = core.resolver.find(q);
      expect(r.sendable).toBe(true);
      expect(r.person_id).toBe(person.id);
    }
    expect(person.id).toMatch(/^p_[0-9A-Z]{26}$/);
    expect(core.identity.detail(person.id).links).toEqual([
      { system: "creator-crm", external_id: "7" },
    ]);
  });
  it("normalizes phone queries and handles", () => {
    const { core, person, handle } = setup("imessage");
    expect(handle.value_normalized).toBe("+13125550123");
    expect(core.resolver.find("312-555-0123").person_id).toBe(person.id);
  });
  it("requires selection for duplicate exact, prefix, token, fuzzy and missing results", () => {
    const { core } = setup();
    for (const q of ["Alice", "Smith", "Alic Smth"])
      expect(core.resolver.find(q).status).toBe("ambiguous");
    expect(core.resolver.find("unknown").status).toBe("not_found");
    core.identity.create({ display_name: "Alice Smith" });
    const r = core.resolver.find("Alice Smith");
    expect(r.sendable).toBe(false);
    expect(r.candidates).toHaveLength(2);
  });
  it("ranks exact above prefix above token above trigram and includes context", () => {
    const { core, event } = setup();
    core.ingest(event());
    core.identity.create({ display_name: "Alice Smithson" });
    core.identity.create({ display_name: "Ms Alice Smith" });
    core.identity.create({ display_name: "Alic Smth" });
    const r = core.resolver.find("Alice Smith");
    expect(r.candidates.map((p) => p.score)).toEqual([
      1,
      0.74,
      0.65,
      expect.any(Number),
    ]);
    expect(r.sendable).toBe(true);
    expect(r.candidates[0].last_channel).toBe("email");
    expect(r.candidates[0].last_message?.text).toBe("hello");
    expect(r.candidates[0].tags).toContain("creator");
  });
  it("updates identity and prevents stealing external links", () => {
    const { core, person } = setup();
    core.identity.update(person.id, {
      notes: "Reviewed",
      aliases: ["A"],
      tags: ["vip"],
    });
    expect(core.identity.get(person.id).notes).toBe("Reviewed");
    const other = core.identity.create({ display_name: "Bob" });
    expect(() =>
      core.identity.update(other.id, {
        links: [{ system: "creator-crm", external_id: "7" }],
      }),
    ).toThrow("another person");
  });
});
describe("ingest and handles", () => {
  it("dedupes repeated ingest and upserts participants", () => {
    const { core, person, event } = setup();
    const first = core.ingest(event({ participants: ["bob@example.com"] }));
    const second = core.ingest(event({ participants: ["bob@example.com"] }));
    expect(second.id).toBe(first.id);
    expect(core.conversations.timeline(person.id)).toHaveLength(1);
    expect(core.conversations.list(person.id)).toHaveLength(1);
    expect(
      core.conversations.detail(first.conversation_id).participants,
    ).toHaveLength(2);
  });
  it("stores unknown senders unlinked until explicit exact-proof linking", () => {
    const { core, person, event } = setup();
    const m = core.ingest(event({ sender: "unknown@example.com" }));
    const unknown = core.handles.unlinked()[0];
    expect(unknown.person_id).toBeNull();
    expect(core.conversations.timeline(person.id)).toHaveLength(0);
    expect(() =>
      core.handles.link(unknown.id, person.id, "agent", "Match", ""),
    ).toThrow("Exact proof");
    core.handles.link(
      unknown.id,
      person.id,
      "owner",
      "Confirmed",
      "Owner confirmed this email",
    );
    expect(core.conversations.timeline(person.id)[0].id).toBe(m.id);
  });
  it("logs every add, value change, relink and unlink with actor/reason", () => {
    const { core, person, handle } = setup();
    const bob = core.identity.create({ display_name: "Bob" });
    core.handles.change(handle.id, {
      value: "new@example.com",
      actor: "agent",
      reason: "Typo correction",
    });
    core.handles.link(
      handle.id,
      bob.id,
      "owner",
      "Wrong identity",
      "Owner correction",
    );
    core.handles.unlink(handle.id, "owner", "Undo");
    const events = core.handles.events(handle.id) as {
      action: string;
      actor: string;
      reason: string;
      person_id_before: string | null;
      person_id_after: string | null;
    }[];
    expect(events.map((e) => e.action)).toEqual([
      "add",
      "change",
      "link",
      "unlink",
    ]);
    expect(events[2]).toMatchObject({
      person_id_before: person.id,
      person_id_after: bob.id,
      actor: "owner",
    });
    expect(events[1].reason).toContain("Typo correction");
  });
  it("dedupes by channel/external ID and rejects conflicting accounts and direction", () => {
    const { core, event } = setup();
    const m = core.ingest(event());
    expect(core.ingest(event()).id).toBe(m.id);
    expect(() => core.ingest(event({ account_id: "other" }))).toThrow("conflicting account");
    expect(() => core.ingest(event({ direction: "out" }))).toThrow(
      "conflicting direction",
    );
  });
});
describe("outbox", () => {
  it("drafts by default, approves once, echoes target and reconciles sync copy", async () => {
    const { core, fake, person, handle, event } = setup();
    const draft = await core.outbox.send({
      person_id: person.id,
      channel: "email",
      text: "hi",
      created_by: "agent",
    });
    expect(draft.status).toBe("draft");
    expect(fake.sent).toHaveLength(0);
    expect(draft.person.id).toBe(person.id);
    expect(draft.handle.id).toBe(handle.id);
    expect(draft.channel).toBe("email");
    const sent = await core.outbox.approve(
      draft.id,
      "owner",
      "Approved outreach",
    );
    expect(sent.status).toBe("sent");
    expect(sent.authorized_by).toBe("owner");
    expect(core.conversations.timeline(person.id)).toHaveLength(1);
    await expect(
      core.outbox.approve(draft.id, "owner", "Again"),
    ).rejects.toThrow("Only draft");
    const reconciled = core.ingest(
      event({
        external_id: fake.sent[0].externalId,
        conversation_external_id: sent.target.conversationExternalId!,
        direction: "out",
        sender: "outreach@excerlock.com",
        text: "hi",
      }),
    );
    expect(reconciled.id).toBe(sent.sent_message_id);
    expect(core.conversations.timeline(person.id)).toHaveLength(1);
  });
  it("sends explicit authorized messages and enforces reason", async () => {
    const { core, fake, person } = setup();
    await expect(
      core.outbox.send({
        person_id: person.id,
        text: "hi",
        created_by: "agent",
        authorized_by: "owner",
      }),
    ).rejects.toThrow("requires a reason");
    const result = await core.outbox.send({
      person_id: person.id,
      text: "hi",
      created_by: "agent",
      authorized_by: "owner",
      reason: "Task instruction",
    });
    expect(result.status).toBe("sent");
    expect(fake.sent).toHaveLength(1);
  });
  it.each(["person", "tag", "kind"] as const)(
    "authorizes matching %s standing rule only on matching channels",
    async (scope) => {
      const { core, person } = setup();
      core.authorization.add({
        scope,
        value:
          scope === "person"
            ? person.id
            : scope === "tag"
              ? "creator"
              : "followup",
        channels: ["email"],
        created_by: "owner",
      });
      const sent = await core.outbox.send({
        person_id: person.id,
        text: "hi",
        kind: "followup",
        created_by: "agent",
      });
      expect(sent.status).toBe("sent");
      expect(sent.reason).toContain("Standing rule");
      expect(sent.authorized_by).toBe("owner");
    },
  );
  it("does not authorize nonmatching kinds and preserves rejected drafts", async () => {
    const { core, person } = setup();
    core.authorization.add({
      scope: "kind",
      value: "reminder",
      channels: ["email"],
      created_by: "owner",
    });
    const draft = await core.outbox.send({
      person_id: person.id,
      text: "hi",
      kind: "outreach",
      created_by: "agent",
    });
    expect(draft.status).toBe("draft");
    expect(core.outbox.list()).toHaveLength(1);
    expect(core.outbox.reject(draft.id, "owner", "No outreach").status).toBe(
      "rejected",
    );
    expect(core.outbox.list()).toHaveLength(0);
    expect(core.outbox.get(draft.id).reason).toBe("No outreach");
  });
  it("refuses a handle belonging to a different person and rechecks draft identity", async () => {
    const { core, person, handle } = setup();
    const bob = core.identity.create({ display_name: "Bob" });
    await expect(
      core.outbox.send({
        person_id: bob.id,
        handle_id: handle.id,
        text: "hi",
        created_by: "agent",
      }),
    ).rejects.toThrow("belong");
    const draft = await core.outbox.send({
      person_id: person.id,
      text: "hi",
      created_by: "agent",
    });
    core.handles.link(
      handle.id,
      bob.id,
      "owner",
      "Correction",
      "Owner confirmed Bob",
    );
    await expect(
      core.outbox.approve(draft.id, "owner", "Send"),
    ).rejects.toThrow("belong");
  });
  it("enforces start capability and reply window, including on delayed approval", async () => {
    const { core, fake, person, event, clock } = setup("tiktok");
    await expect(
      core.outbox.send({
        person_id: person.id,
        text: "hi",
        created_by: "agent",
      }),
    ).rejects.toThrow("cannot start");
    core.ingest(event());
    const draft = await core.outbox.send({
      person_id: person.id,
      text: "reply",
      created_by: "agent",
    });
    clock.now = new Date(clock.now.getTime() + 48 * 3600000);
    await expect(
      core.outbox.approve(draft.id, "owner", "Reply"),
    ).rejects.toThrow("window");
    expect(fake.sent).toHaveLength(0);
    core.ingest(event({ external_id: "newIncoming" }));
    expect(
      (await core.outbox.approve(draft.id, "owner", "Reply now")).status,
    ).toBe("sent");
  });
  it("enforces hourly rate limits across concurrent sends and frees slots after an hour", async () => {
    const { core, fake, person, clock } = setup("instagram", 1);
    const send = () =>
      core.outbox.send({
        person_id: person.id,
        text: "hi",
        created_by: "agent",
        authorized_by: "owner",
        reason: "Test",
      });
    const results = await Promise.allSettled([send(), send()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fake.sent).toHaveLength(1);
    clock.now = new Date(clock.now.getTime() + 3600001);
    expect((await send()).status).toBe("sent");
  });
  it("selects recent conversation and explicit conversation targets; refuses ambiguous groups", async () => {
    const { core, person, event } = setup();
    const m = core.ingest(event());
    const d = await core.outbox.send({
      conversation_id: m.conversation_id,
      text: "reply",
      created_by: "agent",
    });
    expect(d.person_id).toBe(person.id);
    const bob = core.identity.create({ display_name: "Bob" });
    const h = core.handles.add({
      channel: "email",
      person_id: bob.id,
      value: "bob@example.com",
      actor: "owner",
      reason: "Confirmed",
    });
    core.ingest(
      event({
        external_id: "groupMessage",
        conversation_external_id: "group",
        kind: "group",
        participants: [h.value_raw],
      }),
    );
    const group = core.conversations
      .list(person.id)
      .find((c) => c.kind === "group")!;
    await expect(
      core.outbox.send({
        conversation_id: group.id,
        text: "hello",
        created_by: "agent",
      }),
    ).rejects.toThrow("ambiguous");
    expect(
      (
        await core.outbox.send({
          conversation_id: group.id,
          person_id: person.id,
          text: "hello",
          created_by: "agent",
        })
      ).target.conversationKind,
    ).toBe("group");
  });
  it("rejects unsupported CC and stores send failure without automatic retry", async () => {
    const { core, fake, person } = setup("instagram");
    await expect(
      core.outbox.send({
        person_id: person.id,
        text: "hi",
        email_cc: ["bob@example.com"],
        created_by: "agent",
      }),
    ).rejects.toThrow("CC");
    fake.send = async () => {
      throw new Error("Fake failure");
    };
    const result = await core.outbox.send({
      person_id: person.id,
      text: "hi",
      created_by: "agent",
      authorized_by: "owner",
      reason: "Test",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Fake failure");
    await expect(
      core.outbox.approve(result.id, "owner", "Retry"),
    ).rejects.toThrow("Only draft");
  });
});

describe("adapter contract and safety boundaries", () => {
  it("honors channel normalizeHandle and consumes fake sync events", async () => {
    const { core, fake, event } = setup();
    fake.normalizeHandle = (raw: string) =>
      raw.toLowerCase().replace(/^mailto:/, "");
    const h = core.handles.add({
      channel: "email",
      value: "mailto:Bob@example.com",
      actor: "agent",
      reason: "Adapter-normalized",
    });
    expect(h.value_normalized).toBe("bob@example.com");
    fake.events = [event()];
    for await (const e of fake.sync()) core.ingest(e);
    expect(core.conversations.search("hello")).toHaveLength(1);
  });
  it("records fuzzy suggestions without auto-linking", () => {
    const { core, event, person } = setup("instagram");
    core.ingest(event({ sender: "@Alicee" }));
    const h = core.handles
      .unlinked()
      .find((h) => h.value_normalized === "alicee")!;
    expect(h.person_id).toBeNull();
    expect(core.handles.suggestions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          handle_id: h.id,
          person_id: person.id,
          status: "pending",
        }),
      ]),
    );
  });
  it("preserves message identity and person timeline when canonical conversation ID changes", async () => {
    const { core, fake, person, event } = setup();
    const sent = await core.outbox.send({
      person_id: person.id,
      text: "hi",
      created_by: "agent",
      authorized_by: "owner",
      reason: "Test",
    });
    const message = core.ingest(
      event({
        external_id: fake.sent[0].externalId,
        conversation_external_id: "canonical-thread",
        direction: "out",
        sender: "outreach@example.com",
        text: "hi",
      }),
    );
    expect(message.id).toBe(sent.sent_message_id);
    expect(core.conversations.timeline(person.id)).toHaveLength(1);
    expect(core.outbox.get(sent.id).conversation_id).toBe(
      message.conversation_id,
    );
  });
  it("rechecks draft rate limits on approval", async () => {
    const { core, person } = setup("email", 1);
    const draft = await core.outbox.send({
      person_id: person.id,
      text: "hi",
      created_by: "agent",
    });
    await core.outbox.send({
      person_id: person.id,
      text: "other",
      created_by: "agent",
      authorized_by: "owner",
      reason: "Test",
    });
    await expect(
      core.outbox.approve(draft.id, "owner", "Approve"),
    ).rejects.toThrow("rate limit");
    expect(core.outbox.get(draft.id).status).toBe("draft");
  });
});

it("allows rejecting a draft after its handle is unlinked", async () => {
  const { core, person, handle } = setup();
  const draft = await core.outbox.send({
    person_id: person.id,
    text: "hi",
    created_by: "agent",
  });
  core.handles.unlink(handle.id, "owner", "Wrong contact");
  const result = core.outbox.reject(draft.id, "owner", "Discard");
  expect(result.status).toBe("rejected");
  expect(result.person.id).toBe(person.id);
  expect(result.handle.person_id).toBeNull();
});
describe("group safety (live-test regression)", () => {
  it("never targets a group chat implicitly, even when it is the most recent conversation", async () => {
    const { core, person, handle, event } = setup("imessage");
    core.ingest(event({ external_id: "dm1", conversation_external_id: "dm-thread", kind: "direct", participants: [handle.value_raw] }));
    core.ingest(event({ external_id: "g1", conversation_external_id: "family-chat", kind: "group", participants: [handle.value_raw, "+13125550999"], sent_at: "2026-10-12T12:30:00.000Z" }));
    for (const input of [{ person_id: person.id }, { person_id: person.id, handle_id: handle.id }]) {
      const draft = await core.outbox.send({ ...input, channel: "imessage", text: "hi", created_by: "agent" });
      const conv = core.conversations.get(draft.conversation_id!);
      expect(conv.kind).toBe("direct");
      expect(conv.external_id).toBe("dm-thread");
    }
  });
  it("starts a new direct message instead of reusing a group when no 1:1 exists", async () => {
    const { core, person, handle, event } = setup("imessage");
    core.ingest(event({ external_id: "g1", conversation_external_id: "family-chat", kind: "group", participants: [handle.value_raw, "+13125550999"] }));
    const draft = await core.outbox.send({ person_id: person.id, channel: "imessage", text: "hi", created_by: "agent" });
    expect(draft.conversation_id ?? null).toBeNull();
    expect(draft.handle_id).toBe(handle.id);
  });
});
describe("self handles (live-test regression)", () => {
  it("does not add our own sending account as a participant of outgoing messages", async () => {
    const { core, person, handle, event } = setup("imessage");
    // Owner's own number also exists as a person handle (e.g. the owner as a contact).
    core.ingest(event({ external_id: "o1", conversation_external_id: "any;-;+13125550999", kind: "direct", direction: "out", sender: handle.value_raw, participants: ["+13125550999"] }));
    const convs = core.conversations.list(person.id, "imessage");
    expect(convs.map((c) => c.external_id)).not.toContain("any;-;+13125550999");
    const draft = await core.outbox.send({ person_id: person.id, channel: "imessage", text: "hi", created_by: "agent" });
    expect(draft.conversation_id ?? null).toBeNull();
  });
});
describe("email thread replies (live-test regression)", () => {
  it("replies to the latest message of an existing email thread by default", async () => {
    const { core, person, event } = setup("email");
    core.ingest(event({ external_id: "<m1@x>", conversation_external_id: "t1", subject: "Hello" }));
    core.ingest(event({ external_id: "<m2@x>", conversation_external_id: "t1", subject: "Re: Hello", sent_at: "2026-10-12T12:05:00.000Z" }));
    const conv = core.conversations.list(person.id, "email")[0];
    const draft = await core.outbox.send({ conversation_id: conv.id, text: "reply", created_by: "agent" });
    expect(draft.payload.reply_to_external_id).toBe("<m2@x>");
  });
});
describe("resolver noise (live-test regression)", () => {
  it("reports not_found for an unrelated name instead of weak fuzzy candidates", () => {
    const { core } = setup();
    const r = core.resolver.find("nobody-xyz");
    expect(r.status).toBe("not_found");
    expect(r.candidates).toEqual([]);
  });
});
