import { EventEmitter } from "node:events";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createContactsSystem } from "../src/composition.js";
import {
  syncChannel,
  DEFAULT_SYNC_INTERVALS,
  startSyncLoops,
} from "../src/daemon.js";
import { tools } from "../src/mcp/tools.js";
import { accounts, direct, messages, page } from "./fixtures/beeper/data.js";
import type { BeeperTransport } from "../src/channels/instagram.js";
import type { ImsgRunner } from "../src/channels/imessage.js";
import type { ChannelId } from "../src/channels/channel.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(fixture(name));
const clock = () => new Date("2026-10-12T12:00:00Z");
const emailEnv = {
  CONTACTS_CHANNELS: "email",
  CONTACTS_EMAIL_FROM: "outreach@excerlock.com",
  RESEND_API_KEY: "fake-send",
  RESEND_FULL_API_KEY: "fake-read",
};
function harness() {
  const runner: ImsgRunner = {
    async run(args) {
      if (args[0] === "chats")
        return fixture("imsg/chats.ndjson").split("\n")[0];
      if (args[0] !== "history") throw new Error("No fixture sends permitted");
      const flag = (name: string) =>
        args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
      return fixture("imsg/direct.ndjson")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s))
        .filter(
          (row) =>
            (!flag("--start") ||
              Date.parse(row.created_at) >= Date.parse(flag("--start")!)) &&
            (!flag("--end") ||
              Date.parse(row.created_at) < Date.parse(flag("--end")!)),
        )
        .map((row) => JSON.stringify(row))
        .join("\n");
    },
    async *stream(args) {
      yield* (await runner.run(args)).split("\n").filter(Boolean);
    },
    watch: () => () => {},
  };
  const client: BeeperTransport = {
    accounts: { list: async () => accounts },
    chats: {
      async *list() {
        yield { ...direct, ...page([]) };
      },
      retrieve: async () => direct,
      start: async () => {
        throw new Error("No fixture sends permitted");
      },
    },
    messages: {
      async *list() {
        yield* messages.filter((m) => m.chatID === "direct");
      },
      send: async () => {
        throw new Error("No fixture sends permitted");
      },
      retrieve: async () => messages[0],
    },
  };
  let sentCount = 0;
  const calls: { url: URL; init: RequestInit }[] = [];
  const http: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    let body: unknown;
    if (url.host === "api.resend.com") {
      const emails = json("resend/received.json");
      if (url.pathname === "/emails/receiving")
        body = { data: [...emails].reverse(), has_more: false };
      else if (url.pathname.startsWith("/emails/receiving/"))
        body = emails.find((e: { id: string }) =>
          url.pathname.endsWith(`/${e.id}`),
        );
      else if (url.pathname === "/emails" && init.method === "POST")
        body = { id: `sent-${++sentCount}` };
      else if (url.pathname.startsWith("/emails/sent-"))
        body = {
          id: url.pathname.split("/").at(-1),
          message_id: `<${url.pathname.split("/").at(-1)}@resend.com>`,
          created_at: clock().toISOString(),
        };
    } else {
      if (url.pathname.endsWith("/conversations"))
        body = url.searchParams.has("cursor")
          ? { data: [], pagination: { hasMore: false } }
          : json("zernio/conversations.json");
      else if (url.pathname.endsWith("/messages"))
        body = json(
          url.searchParams.has("cursor")
            ? "zernio/messages-page-2.json"
            : "zernio/messages.json",
        );
    }
    if (!body) throw new Error(`Unexpected fixture URL: ${url}`);
    return new Response(JSON.stringify(body));
  };
  return {
    calls,
    adapters: {
      imessage: { runner },
      instagram: { client, accountID: "ig" },
      email: { fetch: http },
      tiktok: { fetch: http, clock },
    },
    env: {
      ...emailEnv,
      CONTACTS_CHANNELS: "imessage,instagram,email,tiktok",
      ZERNIO_API_KEY: "fake-key",
      ZERNIO_TIKTOK_ACCOUNT_ID: "acct-1",
    },
  };
}

it("composes four real adapters on fixtures: cursors, one person timeline, four drafts and a threaded authorized email without duplicates", async () => {
  const fake = harness();
  const { core, registry } = await createContactsSystem({
    ...fake,
    path: ":memory:",
    clock,
  });
  try {
    expect(registry.list().map((c) => c.id)).toEqual([
      "imessage",
      "instagram",
      "email",
      "tiktok",
    ]);
    for (const channel of registry.list()) await syncChannel(core, channel);
    const person = core.identity.create({ display_name: "Fixture person" });
    for (const [channel, account_id, value] of [
      ["imessage", "default", "+14155551212"],
      ["instagram", "ig", "alice"],
      ["email", "default", "zoey@example.com"],
      ["tiktok", "acct-1", "tiktok:user:UserCase1"],
    ] as const) {
      const handle = core.handles.ensure(channel, account_id, value);
      core.handles.link(
        handle.id,
        person.id,
        "owner",
        "Fixture link",
        "Fixture exact identity proof",
      );
      const draft = await tools(core).send_message.call({
        person_id: person.id,
        channel,
        text: "Fixture draft",
        subject: channel === "email" ? "Collaboration" : undefined,
        created_by: "test-agent",
      });
      expect(draft.status).toBe("draft");
    }
    expect(core.outbox.list()).toHaveLength(4);
    expect(
      new Set(
        tools(core)
          .get_timeline.call({ person_id: person.id, limit: 100 })
          .map((m) => m.channel),
      ),
    ).toEqual(new Set(["imessage", "instagram", "email", "tiktok"]));
    const statuses = core.syncStatus();
    expect(statuses).toHaveLength(4);
    expect(
      statuses.every((s) => s.cursor && s.last_ok_at && !s.last_error),
    ).toBe(true);
    expect(statuses.find((s) => s.channel === "instagram")?.account_id).toBe(
      "ig",
    );
    expect(statuses.find((s) => s.channel === "tiktok")?.account_id).toBe(
      "acct-1",
    );
    const before = core.conversations.timeline(person.id).length;
    for (const channel of registry.list()) await syncChannel(core, channel);
    expect(core.conversations.timeline(person.id)).toHaveLength(before);
    const result = await tools(core).send_message.call({
      person_id: person.id,
      channel: "email",
      text: "Authorized fixture reply",
      reply_to_external_id: "r3",
      authorized_by: "owner",
      reason: "Offline test",
      created_by: "agent",
    });
    expect(result.status).toBe("sent");
    const post = fake.calls.find((c) => c.init.method === "POST")!;
    expect(post.init.headers).toMatchObject({ "Idempotency-Key": result.id });
    expect(JSON.parse(String(post.init.body))).toMatchObject({
      subject: "RE: Collaboration",
      headers: {
        "In-Reply-To": "<third@example.com>",
        References:
          "<root@example.com> <second@excerlock.com> <third@example.com>",
      },
    });
    const outgoing = core.conversations
      .timeline(person.id)
      .filter((m) => m.external_id === "sent-1");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).toMatchObject({
      id: result.sent_message_id,
      raw: { message_id: "<sent-1@resend.com>" },
    });
    expect(core.store.all("SELECT * FROM staged_outgoing")).toEqual([]);
    expect(core.conversations.timeline(person.id)).toHaveLength(before + 1);
    expect(DEFAULT_SYNC_INTERVALS).toEqual({
      imessage: 30_000,
      instagram: 300_000,
      email: 120_000,
      tiktok: 120_000,
    });
  } finally {
    core.close();
  }
});

it("reports requested channels missing credentials as disabled without making requests", async () => {
  const { core, registry } = await createContactsSystem({
    path: ":memory:",
    env: { CONTACTS_CHANNELS: "instagram,email,tiktok" },
  });
  try {
    expect(registry.list()).toEqual([]);
    expect(tools(core).sync_status.call()).toHaveLength(4);
    expect(core.syncStatus().every((s) => s.status === "disabled")).toBe(true);
    expect(
      core.syncStatus().find((s) => s.channel === "email")?.disabled_reason,
    ).toContain("RESEND_FULL_API_KEY");
  } finally {
    core.close();
  }
});

it("keeps exact idempotency keys for concurrent identical emails and supports draft approval", async () => {
  const fake = harness();
  const { core } = await createContactsSystem({
    path: ":memory:",
    env: emailEnv,
    adapters: { email: fake.adapters.email },
    clock,
  });
  try {
    const person = core.identity.create({ display_name: "Fixture" });
    core.handles.add({
      channel: "email",
      value: "zoey@example.com",
      person_id: person.id,
      actor: "owner",
      reason: "Exact proof",
    });
    const input = {
      person_id: person.id,
      channel: "email" as const,
      text: "Same body",
      subject: "Same subject",
      created_by: "agent",
    };
    const drafts = await Promise.all([
      core.outbox.send(input),
      core.outbox.send(input),
    ]);
    const sent = await Promise.all(
      drafts.map((d) => core.outbox.approve(d.id, "owner", "Offline fixture")),
    );
    expect(sent.map((s) => s.status)).toEqual(["sent", "sent"]);
    expect(
      new Set(
        fake.calls
          .filter((c) => c.init.method === "POST")
          .map(
            (c) =>
              (c.init.headers as Record<string, string>)["Idempotency-Key"],
          ),
      ),
    ).toEqual(new Set(drafts.map((d) => d.id)));
    expect(core.conversations.timeline(person.id)).toHaveLength(2);
    expect(core.store.all("SELECT * FROM staged_outgoing")).toEqual([]);
  } finally {
    core.close();
  }
});

it("recovers durable sent metadata on restart and replies using stored RFC IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contacts-composition-"));
  const path = join(dir, "contacts.db");
  const fake = harness();
  let system = await createContactsSystem({
    path,
    env: emailEnv,
    adapters: { email: fake.adapters.email },
    clock,
  });
  try {
    const person = system.core.identity.create({ display_name: "Fixture" });
    system.core.handles.add({
      channel: "email",
      value: "zoey@example.com",
      person_id: person.id,
      actor: "owner",
      reason: "Exact proof",
    });
    const reconcile = vi
      .spyOn(system.core, "reconcileOutgoing")
      .mockImplementationOnce(() => {
        throw new Error("Simulated interruption after dispatch commit");
      });
    await expect(
      system.core.outbox.send({
        person_id: person.id,
        channel: "email",
        text: "First",
        subject: "Thread",
        created_by: "agent",
        authorized_by: "owner",
        reason: "Offline",
      }),
    ).rejects.toThrow("Simulated interruption");
    expect(system.core.store.all("SELECT * FROM staged_outgoing")).toHaveLength(
      1,
    );
    reconcile.mockRestore();
    system.core.close();
    system = await createContactsSystem({
      path,
      env: emailEnv,
      adapters: { email: fake.adapters.email },
      clock,
    });
    expect(system.core.store.all("SELECT * FROM staged_outgoing")).toEqual([]);
    const reply = await system.core.outbox.send({
      person_id: person.id,
      channel: "email",
      text: "Second",
      reply_to_external_id: "<sent-1@resend.com>",
      created_by: "agent",
      authorized_by: "owner",
      reason: "Offline",
    });
    expect(reply.status).toBe("sent");
    expect(
      JSON.parse(
        String(
          fake.calls.filter((c) => c.init.method === "POST").at(-1)!.init.body,
        ),
      ).headers,
    ).toEqual({
      "In-Reply-To": "<sent-1@resend.com>",
      References: "<sent-1@resend.com>",
    });
    expect(system.core.conversations.timeline(person.id)).toHaveLength(2);
  } finally {
    system.core.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("runs composed polling and live listeners, reports socket errors and stops cleanly", async () => {
  const fake = harness();
  const socket = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    close: vi.fn(),
  });
  let onLine: ((line: string) => void) | undefined;
  const stopWatch = vi.fn();
  fake.adapters.imessage.runner.watch = (_args, listener) => {
    onLine = listener;
    return stopWatch;
  };
  const { core, registry } = await createContactsSystem({
    ...fake,
    path: ":memory:",
    clock,
    adapters: {
      ...fake.adapters,
      instagram: { ...fake.adapters.instagram, socketFactory: () => socket },
    },
  });
  const loops = startSyncLoops(core, registry);
  try {
    await expect
      .poll(() => core.syncStatus().filter((s) => s.last_ok_at).length)
      .toBe(4);
    const cursors = core.syncStatus().map((s) => s.cursor);
    const live = { ...messages[0], id: "live-only", text: "Live incoming" };
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "message.upserted",
          chatID: "direct",
          entries: [live],
        }),
      ),
    );
    onLine!(
      JSON.stringify({
        ...JSON.parse(fixture("imsg/direct.ndjson").split("\n")[1]),
        id: 100,
        guid: "live-imsg",
        text: "Live incoming",
      }),
    );
    await expect
      .poll(() => core.conversations.search("Live incoming").length)
      .toBe(2);
    expect(core.syncStatus().map((s) => s.cursor)).toEqual(cursors);
    socket.emit("error", new Error("Fixture socket disconnected"));
    expect(
      core.syncStatus().find((s) => s.channel === "instagram")?.last_error,
    ).toContain("Fixture socket disconnected");
  } finally {
    await loops.close();
    core.close();
  }
  expect(stopWatch).toHaveBeenCalledOnce();
  expect(socket.close).toHaveBeenCalled();
});

it.each(["instagram", "email", "tiktok"] as ChannelId[])(
  "replays safely after an interrupted %s ingest",
  async (channelId) => {
    const fake = harness();
    const { core, registry } = await createContactsSystem({
      ...fake,
      path: ":memory:",
      clock,
    });
    try {
      const channel = registry.get(channelId);
      const ingest = core.ingest.bind(core);
      let consumed = 0;
      const spy = vi.spyOn(core, "ingest").mockImplementation((event) => {
        if (++consumed === 2) throw new Error("Fixture ingest interruption");
        return ingest(event);
      });
      await expect(syncChannel(core, channel)).rejects.toThrow(
        "Fixture ingest interruption",
      );
      const state = core.syncStatus().find((s) => s.channel === channelId)!;
      expect(state.last_error).toContain("Fixture ingest interruption");
      expect(state.last_ok_at).toBeNull();
      if (channelId !== "tiktok") expect(state.cursor).toBeTruthy();
      spy.mockRestore();
      await syncChannel(core, channel);
      expect(core.conversations.search("", undefined, channelId)).toHaveLength(
        channelId === "instagram" ? 2 : 3,
      );
      expect(
        core.syncStatus().find((s) => s.channel === channelId)?.last_error,
      ).toBeNull();
    } finally {
      core.close();
    }
  },
);

it("honors an environment send-rate override before any provider call", async () => {
  const fake = harness();
  const { core } = await createContactsSystem({
    path: ":memory:",
    env: { ...emailEnv, CONTACTS_RATE_LIMIT_EMAIL: "0" },
    adapters: { email: fake.adapters.email },
    clock,
  });
  try {
    const person = core.identity.create({ display_name: "Fixture" });
    core.handles.add({
      person_id: person.id,
      channel: "email",
      value: "zoey@example.com",
      actor: "owner",
      reason: "Exact proof",
    });
    await expect(
      core.outbox.send({
        person_id: person.id,
        channel: "email",
        text: "Blocked",
        subject: "Blocked",
        created_by: "agent",
        authorized_by: "owner",
        reason: "Offline",
      }),
    ).rejects.toThrow("hourly rate limit");
    expect(fake.calls).toHaveLength(0);
  } finally {
    core.close();
  }
});
