import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createEmailChannel,
  type EmailChannelOptions,
  type ResendEmail,
} from "../src/channels/email.js";
import type { IngestEvent, SendTarget } from "../src/channels/channel.js";
import { ContactsCore } from "../src/core/index.js";
import { ChannelRegistry } from "../src/channels/registry.js";

const fixture = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/resend/${file}`, import.meta.url), "utf8"),
  );
const received: ResendEmail[] = fixture("received.json");
const target: SendTarget = {
  person_id: "p1",
  handle_id: "h1",
  handle: "zoey@example.com",
  channel: "email",
  account_id: "default",
};
function harness(emails = received, extra: Partial<EmailChannelOptions> = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const staged: IngestEvent[] = [];
  const fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    let body: unknown;
    if (url.pathname === "/emails" && init.method === "POST")
      body = { id: "sent1" };
    else if (url.pathname === "/emails/sent1")
      body = {
        id: "sent1",
        message_id: "<actual@resend.com>",
        created_at: "2026-10-04T12:00:00Z",
      };
    else if (url.pathname === "/emails/receiving") {
      const newest = [...emails].reverse();
      const after = url.searchParams.get("after");
      const start = after ? newest.findIndex((e) => e.id === after) + 1 : 0;
      const end = start + Number(url.searchParams.get("limit"));
      body = { data: newest.slice(start, end), has_more: end < newest.length };
    } else
      body = emails.find((e) => url.pathname === `/emails/receiving/${e.id}`);
    if (!body) throw new Error(`Unexpected test URL ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const channel = createEmailChannel({
    from: "ExcerLock <outreach@excerlock.com>",
    apiKey: "send-test",
    fullApiKey: "read-test",
    replyTo: "replies@excerlock.com",
    pageSize: 2,
    fetch: fetch as typeof globalThis.fetch,
    onSent: (event) => {
      staged.push(event);
    },
    getOutboxId: () => "o_test",
    ...extra,
  });
  return { channel, calls, staged };
}
async function collect(events: AsyncIterable<IngestEvent>) {
  const result: IngestEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
describe("Resend email channel", () => {
  it("maps full received content and ingests paginated history oldest first", async () => {
    const { channel, calls } = harness();
    const events = await collect(channel.sync());
    expect(events.map((e) => e.external_id)).toEqual(["r1", "r2", "r3"]);
    expect(events[0]).toMatchObject({
      sender: "zoey@example.com",
      participants: [
        "manager@example.com",
        "outreach@excerlock.com",
        "zoey@example.com",
      ],
      kind: "group",
      direction: "in",
      text: "Let's talk",
      email_cc: ["manager@example.com"],
      raw: received[0],
    });
    expect(events[1].direction).toBe("out");
    expect(new Set(events.map((e) => e.conversation_external_id)).size).toBe(1);
    expect(events[2].reply_to_external_id).toBe("r2");
    const lists = calls.filter((c) => c.url.pathname === "/emails/receiving");
    expect(lists.map((c) => c.url.searchParams.get("after"))).toEqual([
      null,
      "r2",
    ]);
    expect(
      calls.every(
        (c) =>
          (c.init.headers as Record<string, string>).Authorization ===
          "Bearer read-test",
      ),
    ).toBe(true);
  });
  it("resumes from a cursor within a page without fetching old bodies", async () => {
    const { channel, calls } = harness();
    expect(
      (await collect(channel.sync("r2"))).map((e) => e.external_id),
    ).toEqual(["r3"]);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/emails/receiving",
      "/emails/receiving/r3",
    ]);
    expect(await collect(channel.sync("r3"))).toEqual([]);
  });
  it("stops at a cursor on a later page and backfills when cursor is absent", async () => {
    expect(
      (await collect(harness().channel.sync("r1"))).map((e) => e.external_id),
    ).toEqual(["r2", "r3"]);
    expect(
      (await collect(harness().channel.sync("expired"))).map(
        (e) => e.external_id,
      ),
    ).toEqual(["r1", "r2", "r3"]);
    expect(await collect(harness([]).channel.sync())).toEqual([]);
  });
  it("groups subject fallback by normalized subject and exact visible participants", async () => {
    const same = {
      ...received[0],
      id: "r4",
      subject: " Fwd: RE:  Collaboration ",
      message_id: "<fourth@example.com>",
      headers: {},
    };
    const different = { ...same, id: "r5", to: ["someone@excerlock.com"] };
    const events = await collect(
      harness([received[0], same, different]).channel.sync(),
    );
    expect(events[1].conversation_external_id).toBe(
      events[0].conversation_external_id,
    );
    expect(events[2].conversation_external_id).not.toBe(
      events[0].conversation_external_id,
    );
  });
  it("groups unseen RFC roots despite changing subjects and participants", async () => {
    const first = {
      ...received[1],
      headers: {
        References: "<unseen@example.com>",
        "In-Reply-To": "<unseen@example.com>",
      },
    };
    const second = {
      ...received[2],
      subject: "Updated offer",
      cc: [],
      headers: {
        References: "<unseen@example.com> <second@excerlock.com>",
        "In-Reply-To": "<second@excerlock.com>",
      },
    };
    const events = await collect(harness([first, second]).channel.sync());
    expect(events[0].conversation_external_id).toMatch(/^email:thread:/);
    expect(events[1].conversation_external_id).toBe(
      events[0].conversation_external_id,
    );
  });
  it("follows In-Reply-To-only chains through the known parent", async () => {
    const emails = received.map((e) => ({
      ...e,
      headers: {
        "In-Reply-To":
          e.id === "r2"
            ? "<root@example.com>"
            : e.id === "r3"
              ? "<second@excerlock.com>"
              : "",
      },
    }));
    const events = await collect(harness(emails).channel.sync());
    expect(new Set(events.map((e) => e.conversation_external_id)).size).toBe(1);
  });
  it("does not yield or advance a cursor when a later list page fails", async () => {
    let calls = 0;
    const { channel } = harness(undefined, {
      fetch: async () => {
        if (++calls === 1)
          return new Response(
            JSON.stringify({ data: [received[2]], has_more: true }),
          );
        return new Response("unavailable", { status: 503 });
      },
    });
    const iterator = channel.sync("r1")[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("HTTP 503");
  });
  it("resolves the stored RFC root across restart/cursor resume", async () => {
    const history = await collect(harness().channel.sync());
    const { channel } = harness(undefined, {
      lookupMessage: (id) =>
        history.find(
          (e) =>
            e.external_id === id || (e.raw as ResendEmail).message_id === id,
        ),
    });
    const events = await collect(channel.sync("r2"));
    expect(events[0].conversation_external_id).toBe(
      history[0].conversation_external_id,
    );
    expect(events[0].reply_to_external_id).toBe("r2");
  });
  it("sends cc/bcc/html/reply-to with stored threading headers and outbox idempotency", async () => {
    const { channel, calls, staged } = harness();
    const history = await collect(channel.sync());
    const result = await channel.send(target, {
      text: "Hello",
      subject: "Re: Collaboration",
      html: "<p>Hello</p>",
      email_to: ["ZOEY@example.com", "Other <OTHER@example.com>"],
      email_cc: ["MANAGER@example.com"],
      email_bcc: ["private@example.com"],
      reply_to_external_id: "r2",
    });
    const send = calls.find((c) => c.init.method === "POST")!;
    expect(JSON.parse(send.init.body as string)).toEqual(
      fixture("send-payload.json"),
    );
    expect(send.init.headers).toMatchObject({
      Authorization: "Bearer send-test",
      "Idempotency-Key": "o_test",
    });
    expect(result).toEqual({
      externalId: "sent1",
      conversationExternalId: history[0].conversation_external_id,
    });
    expect(staged[0]).toMatchObject({
      direction: "out",
      email_bcc: ["private@example.com"],
      raw: { message_id: "<actual@resend.com>" },
    });
    expect(staged[0].participants).not.toContain("private@example.com");
  });
  it("defaults To to the handle and supports direct adapter outbox_id", async () => {
    const { channel, calls } = harness(undefined, { getOutboxId: undefined });
    expect(channel.capabilities).toEqual({
      startConversation: true,
      groups: true,
      cc: true,
    });
    expect(channel.normalizeHandle(" Zoey <ZOEY@example.com> ")).toBe(
      "zoey@example.com",
    );
    await channel.send(target, {
      text: "Hi",
      subject: "Hello",
      outbox_id: "o_explicit",
    });
    const send = calls.find((c) => c.init.method === "POST")!;
    expect(JSON.parse(send.init.body as string).to).toEqual([target.handle]);
    expect(send.init.headers).toMatchObject({
      "Idempotency-Key": "o_explicit",
    });
  });
  it("rejects missing outbox/subject/parent before HTTP send", async () => {
    const { channel, calls } = harness(undefined, { getOutboxId: undefined });
    await expect(
      channel.send(target, { text: "Hi", subject: "Hi" }),
    ).rejects.toThrow("outbox ID");
    expect(calls).toHaveLength(0);
    const h = harness();
    await expect(h.channel.send(target, { text: "Hi" })).rejects.toThrow(
      "subject required",
    );
    await expect(
      h.channel.send(target, {
        text: "Hi",
        subject: "Hi",
        reply_to_external_id: "missing",
      }),
    ).rejects.toThrow("not found");
    expect(h.calls).toHaveLength(0);
  });
  it("keeps successful send successful when Message-ID retrieval is unavailable", async () => {
    const { channel, staged } = harness(undefined, {
      fetch: async (url, init) =>
        String(url).endsWith("/emails/sent1")
          ? new Response("private error", { status: 403 })
          : await baseFetch(url, init),
    });
    async function baseFetch(
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) {
      if (init?.method === "POST") return new Response('{"id":"sent1"}');
      throw new Error("Unexpected request");
    }
    await expect(
      channel.send(target, { text: "Hi", subject: "Hello" }),
    ).resolves.toMatchObject({ externalId: "sent1" });
    expect(staged).toHaveLength(1);
    await expect(
      channel.send(target, { text: "Reply", reply_to_external_id: "sent1" }),
    ).rejects.toThrow("stored RFC Message-ID");
  });
  it("retries a failed staging sink without resending the successful email", async () => {
    let fail = true;
    const stored: IngestEvent[] = [];
    const { channel, calls } = harness(undefined, {
      onSent: (event) => {
        if (fail) throw new Error("storage offline");
        stored.push(event);
      },
    });
    await expect(
      channel.send(target, { text: "Hi", subject: "Hello" }),
    ).resolves.toMatchObject({ externalId: "sent1" });
    fail = false;
    await channel.flushSent();
    await channel.flushSent();
    expect(stored).toHaveLength(1);
    expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });
  it("fails HTTP and stalled pagination without exposing provider content", async () => {
    const denied = harness(undefined, {
      fetch: async () => new Response("sensitive secret", { status: 401 }),
    });
    await expect(collect(denied.channel.sync())).rejects.toThrow("HTTP 401");
    const stalled = harness(undefined, {
      fetch: async () =>
        new Response(JSON.stringify({ data: [received[0]], has_more: true })),
    });
    await expect(collect(stalled.channel.sync())).rejects.toThrow(
      "did not advance",
    );
  });
  it("reconciles sent metadata after phase 1 dispatch without duplicating messages", async () => {
    let core: ContactsCore;
    const { channel, staged } = harness(undefined, {
      getOutboxId: () => {
        const rows = core.store.all<{ id: string }>(
          "SELECT id FROM outbox WHERE channel='email' AND status='sending'",
        );
        if (rows.length !== 1) throw new Error("Ambiguous dispatch");
        return rows[0].id;
      },
    });
    core = new ContactsCore({
      path: ":memory:",
      registry: new ChannelRegistry([channel]),
    });
    try {
      const person = core.identity.create({ display_name: "Zoey" });
      core.handles.add({
        person_id: person.id,
        channel: "email",
        value: "zoey@example.com",
        actor: "test",
        reason: "test",
      });
      const result = await core.outbox.send({
        person_id: person.id,
        channel: "email",
        text: "Hello",
        subject: "Collaboration",
        created_by: "test",
        authorized_by: "test",
        reason: "offline test",
      });
      expect(result.status).toBe("sent");
      for (const event of staged) core.ingest(event);
      expect(core.store.all("SELECT * FROM messages")).toHaveLength(1);
      expect(
        core.store.one<{ raw: ResendEmail }>("SELECT raw FROM messages")!.raw
          .message_id,
      ).toBe("<actual@resend.com>");
    } finally {
      core.close();
    }
  });
});
