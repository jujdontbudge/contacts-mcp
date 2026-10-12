import { afterEach, expect, it } from "vitest";
import { ContactsCore } from "../src/core/index.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { FakeChannel } from "../src/channels/fake.js";
import { tools } from "../src/mcp/tools.js";
import type { IngestEvent } from "../src/channels/channel.js";
const opened: ContactsCore[] = [];
afterEach(() => opened.splice(0).forEach((c) => c.close()));
function setup() {
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([new FakeChannel("email")]),
  });
  opened.push(core);
  const person = core.identity.create({ display_name: "Alice" });
  return { core, person };
}
const email = (changes: Partial<IngestEvent> = {}): IngestEvent => ({
  channel: "email",
  account_id: "default",
  external_id: "sent",
  conversation_external_id: "original",
  direction: "out",
  sender: "outreach@excerlock.com",
  participants: ["alice@example.com"],
  text: "hello",
  subject: "Collaboration",
  email_to: ["alice@example.com"],
  sent_at: "2026-10-12T10:00:00Z",
  raw: { message_id: "<ses@example.com>" },
  ...changes,
});
it("add_handle links a synced unlinked handle and is idempotent with an audited link", () => {
  const { core, person } = setup();
  const h = core.handles.ensure("email", "default", "alice@example.com");
  const input = {
    channel: "email" as const,
    value: "ALICE@example.com",
    person_id: person.id,
    actor: "owner",
    reason: "Confirmed bio",
  };
  expect(core.handles.add(input)).toMatchObject({
    id: h.id,
    person_id: person.id,
  });
  expect(core.handles.add(input).id).toBe(h.id);
  expect(core.handles.events(h.id)).toHaveLength(2);
  expect(core.handles.events(h.id)[1]).toMatchObject({
    action: "link",
    actor: "owner",
    reason: "Confirmed bio",
  });
  const other = core.identity.create({ display_name: "Other" });
  expect(() => core.handles.add({ ...input, person_id: other.id })).toThrow(
    new RegExp(`${person.id}.*change_handle`),
  );
});
it("link_handle accepts boolean exact proof and logs the attestation", () => {
  const { core, person } = setup();
  const h = core.handles.ensure("email", "default", "alice@example.com");
  const t = tools(core).link_handle;
  const args = t.schema.parse({
    handle_id: h.id,
    person_id: person.id,
    actor: "owner",
    reason: "Verified",
    exact_proof: true,
  });
  expect(t.call(args).person_id).toBe(person.id);
  expect(t.schema.safeParse({ ...args, exact_proof: false }).success).toBe(
    false,
  );
});
it("send_message accepts a linked handle alone, rejects unlinked handles, and keeps draft authorization", async () => {
  const { core, person } = setup();
  const h = core.handles.add({
    channel: "email",
    value: "alice@example.com",
    person_id: person.id,
    actor: "owner",
    reason: "Confirmed",
  });
  const t = tools(core).send_message;
  const args = t.schema.parse({
    handle_id: h.id,
    text: "hello",
    created_by: "agent",
  });
  expect(await t.call(args)).toMatchObject({
    status: "draft",
    person_id: person.id,
    handle_id: h.id,
  });
  const unknown = core.handles.ensure(
    "email",
    "default",
    "unknown@example.com",
  );
  await expect(
    core.outbox.send({
      handle_id: unknown.id,
      text: "hello",
      created_by: "agent",
    }),
  ).rejects.toThrow("unlinked");
});
it("message tools omit raw by default, opt in explicitly, and retain DB payloads", async () => {
  const { core, person } = setup();
  const h = core.handles.add({
    channel: "email",
    value: "alice@example.com",
    person_id: person.id,
    actor: "owner",
    reason: "Confirmed",
  });
  const m = core.ingest(email());
  const t = tools(core);
  const requests = [
    [t.get_timeline, { person_id: person.id, limit: 100 }],
    [t.search_messages, { query: "hello", limit: 100 }],
  ] as const;
  for (const [tool, args] of requests) {
    const invoke = tool.call as (a: any) => any;
    expect(invoke(tool.schema.parse(args))[0]).not.toHaveProperty("raw");
    expect(
      invoke(tool.schema.parse({ ...args, include_raw: true }))[0].raw,
    ).toEqual({ message_id: "<ses@example.com>" });
  }
  expect(
    t.get_conversation.call(
      t.get_conversation.schema.parse({ conversation_id: m.conversation_id }),
    ).messages[0],
  ).not.toHaveProperty("raw");
  expect(
    t.get_conversation.call(
      t.get_conversation.schema.parse({
        conversation_id: m.conversation_id,
        include_raw: true,
      }),
    ).messages[0],
  ).toHaveProperty("raw");
  expect(
    t.send_message.schema.safeParse({
      handle_id: h.id,
      text: "hello",
      created_by: "agent",
      include_raw: true,
    }).success,
  ).toBe(true);
  expect(
    core.conversations.detail(m.conversation_id).messages[0],
  ).toHaveProperty("raw");
  const sendArgs = {
    handle_id: h.id,
    text: "fake send",
    created_by: "agent",
    authorized_by: "owner",
    reason: "Offline",
  };
  const compact = await t.send_message.call(
    t.send_message.schema.parse(sendArgs),
  );
  expect(JSON.stringify(compact)).not.toContain('"raw"');
  const full = await t.send_message.call(
    t.send_message.schema.parse({ ...sendArgs, include_raw: true }),
  );
  expect(full).toHaveProperty("message.raw");
});
it.each(["parent", "references", "subject"])(
  "email ingest joins original conversation using %s across restarts/cache boundaries",
  (mode) => {
    const { core } = setup();
    const sent = core.ingest(email());
    const incoming = email({
      external_id: "reply",
      conversation_external_id: "split",
      direction: "in",
      sender: "alice@example.com",
      participants: ["outreach@excerlock.com"],
      subject: "AW: Fwd: Re: Collaboration",
      sent_at: "2026-10-12T11:00:00Z",
      reply_to_external_id: mode === "parent" ? "<ses@example.com>" : undefined,
      raw: {
        headers:
          mode === "references"
            ? {
                References:
                  "<unknown@example.com> <ses@example.com> <other@example.com>",
              }
            : {},
      },
    });
    expect(core.ingest(incoming).conversation_id).toBe(sent.conversation_id);
    const other = core.ingest({
      ...incoming,
      external_id: "other",
      sender: "other@example.com",
      conversation_external_id: "other-thread",
      reply_to_external_id: undefined,
      raw: {},
    });
    expect(other.conversation_id).not.toBe(sent.conversation_id);
  },
);
it("repair merges legacy split threads, updates drafts, preserves messages and is idempotent", async () => {
  const { core, person } = setup();
  core.handles.add({
    channel: "email",
    value: "alice@example.com",
    person_id: person.id,
    actor: "owner",
    reason: "Confirmed",
  });
  const first = core.ingest(email());
  // Insert legacy data directly: bypass the corrected ingestion matcher.
  const split = core.conversations.upsert(
    "email",
    "default",
    "split",
    "direct",
  );
  const reply = core.ingest(
    email({
      external_id: "reply",
      conversation_external_id: "split",
      direction: "in",
      sender: "alice@example.com",
      subject: "Unrelated",
      raw: {},
    }),
  );
  core.store.run(
    "UPDATE messages SET conversation_id=?,subject=?,reply_to_external_id=? WHERE id=?",
    split.id,
    "Re: Collaboration",
    "<ses@example.com>",
    reply.id,
  );
  core.store.run(
    "INSERT OR IGNORE INTO conversation_participants VALUES (?,?)",
    split.id,
    core.handles.ensure("email", "default", "alice@example.com").id,
  );
  const draft = await core.outbox.send({
    conversation_id: split.id,
    text: "draft",
    created_by: "agent",
  });
  const repair = core.conversations.repairEmailThreads();
  expect(repair.merged).toBe(1);
  expect(
    core.conversations.detail(first.conversation_id).messages,
  ).toHaveLength(2);
  expect(core.outbox.get(draft.id).conversation_id).toBe(first.conversation_id);
  expect(core.conversations.repairEmailThreads().merged).toBe(0);
});
it("email fallback isolates accounts and group counterparts", () => {
  const { core } = setup();
  const first = core.ingest(email());
  const grouped = core.ingest(
    email({
      external_id: "group-reply",
      conversation_external_id: "group",
      direction: "in",
      sender: "alice@example.com",
      email_cc: ["other@example.com"],
      raw: {},
    }),
  );
  expect(grouped.conversation_id).not.toBe(first.conversation_id);
  const foreign = core.ingest(
    email({
      external_id: "foreign-reply",
      account_id: "other-account",
      conversation_external_id: "foreign",
      direction: "in",
      sender: "alice@example.com",
      reply_to_external_id: "<ses@example.com>",
      raw: {},
    }),
  );
  expect(foreign.conversation_id).not.toBe(first.conversation_id);
});
it.each(["subject", "references"])(
  "repair uses %s and never merges another counterpart",
  (mode) => {
    const { core } = setup();
    const first = core.ingest(email());
    const reply = core.ingest(
      email({
        external_id: "reply",
        conversation_external_id: "legacy",
        direction: "in",
        sender: "alice@example.com",
        sent_at: "2026-10-12T11:00:00Z",
        subject: mode === "subject" ? "Re: Collaboration" : "Changed subject",
        raw: {},
      }),
    );
    const legacy = core.conversations.upsert(
      "email",
      "default",
      "legacy",
      "direct",
    );
    core.store.run(
      "UPDATE messages SET conversation_id=?,raw=? WHERE id=?",
      legacy.id,
      JSON.stringify(
        mode === "references"
          ? {
              headers: {
                References: "<unknown@example.com> <ses@example.com>",
              },
            }
          : {},
      ),
      reply.id,
    );
    const other = core.ingest(
      email({
        external_id: "other",
        conversation_external_id: "other",
        direction: "in",
        sender: "other@example.com",
        subject: "Collaboration",
        raw: {},
      }),
    );
    expect(core.conversations.repairEmailThreads().merged).toBe(1);
    expect(
      core.conversations.detail(first.conversation_id).messages,
    ).toHaveLength(2);
    expect(
      core.conversations.detail(other.conversation_id).messages,
    ).toHaveLength(1);
  },
);
