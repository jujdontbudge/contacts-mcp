import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  IMessageChannel,
  parseImsgJSON,
  type ImsgRunner,
} from "../src/channels/imessage.js";
import type { SendTarget } from "../src/channels/channel.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { ContactsCore } from "../src/core/index.js";
import { syncChannel } from "../src/daemon.js";
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/imsg/${name}.ndjson`, import.meta.url),
    "utf8",
  );
class Runner implements ImsgRunner {
  calls: string[][] = [];
  sent = false;
  confirm = true;
  failChat?: string;
  line?: (line: string) => void;
  exit?: (error: Error) => void;
  stopped = 0;
  watchCalls = 0;
  outgoing(chat: number) {
    return JSON.stringify({
      id: 50,
      guid: "sent-50",
      chat_id: chat,
      chat_guid: chat === 1 ? "iMessage;-;+14155551212" : "iMessage;+;chat123",
      is_group: chat === 2,
      participants: ["+14155551212"],
      sender: "",
      is_from_me: true,
      text: "New text",
      created_at: new Date().toISOString(),
      attachments: [],
    });
  }
  async run(args: string[]) {
    this.calls.push(args);
    if (args[0] === "chats") return fixture("chats");
    if (args[0] === "send") {
      this.sent = true;
      return '{"status":"sent","guid":"sent-50"}';
    }
    if (args[0] === "history") {
      if (args[2] === this.failChat)
        throw new Error("authorization denied (code: 23)");
      const rows = parseImsgJSON(
        fixture(args[2] === "1" ? "direct" : "group") +
          (this.sent && this.confirm
            ? `${this.outgoing(Number(args[2]))}\n`
            : ""),
      );
      return this.filtered(rows, args);
    }
    throw new Error("Unexpected command");
  }
  filtered(rows: Record<string, unknown>[], args: string[]) {
    const value = (flag: string) =>
      args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const start = value("--start"),
      end = value("--end");
    return rows
      .filter(
        (row) =>
          (!start || Date.parse(String(row.created_at)) >= Date.parse(start)) &&
          (!end || Date.parse(String(row.created_at)) < Date.parse(end)),
      )
      .sort(
        (a, b) =>
          Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)) ||
          Number(b.id) - Number(a.id),
      )
      .slice(0, Number(value("--limit") ?? 50))
      .map((row) => JSON.stringify(row) + "\n")
      .join("");
  }
  async *stream(args: string[]) {
    const output = await this.run(args);
    yield* output.split("\n").filter(Boolean);
  }
  watch(
    _args: string[],
    line: (line: string) => void,
    exit: (error: Error) => void,
  ) {
    this.watchCalls++;
    this.line = line;
    this.exit = exit;
    return () => {
      this.stopped++;
    };
  }
}
const target: SendTarget = {
  person_id: "p_1",
  handle_id: "h_1",
  handle: "+14155551212",
  channel: "imessage",
  account_id: "default",
};
it("refuses a stale or nonmember group recipient before invoking imsg send", async () => {
  const runner = new Runner(), channel = new IMessageChannel({ runner });
  await expect(channel.send({ ...target, handle: "+13125550123", conversationKind: "group", conversationExternalId: "iMessage;+;chat123" }, { text: "New text" })).rejects.toThrow("participant");
  expect(runner.calls.some(args => args[0] === "send")).toBe(false);
});
it("cannot treat a group GUID lacking is_group as a direct chat confirmation", async () => {
  const runner = new Runner();
  const run = runner.run.bind(runner);
  runner.run = async args => args[0] === "chats" ? JSON.stringify({ id: 2, guid: "iMessage;+;chat123", identifier: "chat123", participants: [target.handle] }) : run(args);
  const channel = new IMessageChannel({ runner, confirmationTimeoutMs: 1, confirmationPollMs: 0 });
  await expect(channel.send(target, { text: "New text" })).rejects.toThrow("uncertain");
});
it("maps documented direct/group, email, outgoing, attachments and missing sender into unlinked handles", async () => {
  const channel = new IMessageChannel({ runner: new Runner() });
  const events = (await Array.fromAsync(channel.sync())).sort(
    (a, b) => (a.raw as any).imsg_rowid - (b.raw as any).imsg_rowid,
  );
  expect(events.map((e) => (e.raw as any).imsg_rowid)).toEqual([2, 5, 7, 12]);
  expect(events[0].sender).toBe("+14155551212");
  expect(events[0].attachments).toEqual([
    {
      url: "file:///offline/photo.jpg",
      mimeType: "image/jpeg",
      name: "photo.jpg",
    },
  ]);
  expect((events[0].raw as any).attachments[0].total_bytes).toBe(1234);
  expect(events[2]).toMatchObject({
    kind: "group",
    sender: "bob@example.com",
    conversation_external_id: "iMessage;+;chat123",
    reply_to_external_id: "msg-2",
  });
  expect(events[2].participants).toEqual(["+14155551212", "bob@example.com"]);
  expect(events[3]).toMatchObject({ direction: "out", sender: "+14155559999" });
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([channel]),
  });
  try {
    events.forEach((e) => core.ingest(e));
    expect(core.handles.unlinked().map((h) => h.value_normalized)).toContain(
      "unknown-5@contacts-mcp.invalid",
    );
  } finally {
    core.close();
  }
});
it("migrates legacy cursors and resumes backfill after partial ingest failure", async () => {
  const channel = new IMessageChannel({ runner: new Runner() });
  expect(
    (await Array.fromAsync(channel.sync("5"))).map((e) => e.external_id),
  ).toEqual(["msg-12", "msg-7"]);
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([channel]),
  });
  const original = core.ingest.bind(core);
  const spy = vi.spyOn(core, "ingest").mockImplementation((e) => {
    if (e.external_id === "msg-7") throw new Error("disk failure");
    return original(e);
  });
  try {
    await expect(syncChannel(core, channel)).rejects.toThrow("disk failure");
    expect(core.syncStatus()[0]).toMatchObject({
      last_error: "disk failure",
      last_ok_at: null,
    });
    expect(JSON.parse(core.syncStatus()[0].cursor!).backfill.completed).toEqual(
      [1],
    );
    spy.mockRestore();
    await syncChannel(core, channel);
    expect(core.syncStatus()[0]).toMatchObject({
      last_error: null,
    });
    expect(
      core.store.one<{ n: number }>("SELECT COUNT(*) n FROM messages")?.n,
    ).toBe(4);
  } finally {
    core.close();
  }
});
it("keeps completed backfill progress when another chat read fails", async () => {
  const runner = new Runner();
  runner.failChat = "2";
  const channel = new IMessageChannel({ runner });
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([channel]),
  });
  try {
    await expect(syncChannel(core, channel)).rejects.toThrow(
      "authorization denied",
    );
    expect(JSON.parse(core.syncStatus()[0].cursor!).backfill.completed).toEqual(
      [1],
    );
    expect(core.syncStatus()[0].last_ok_at).toBeNull();
  } finally {
    core.close();
  }
});
it("confirms a new direct outgoing GUID and routes group sends through the stable identifier", async () => {
  for (const group of [false, true]) {
    const runner = new Runner();
    const channel = new IMessageChannel({ runner });
    const sent = await channel.send(
      {
        ...target,
        ...(group
          ? {
              conversationKind: "group",
              conversationExternalId: "iMessage;+;chat123",
            }
          : {}),
      },
      { text: "New text" },
    );
    expect(sent.externalId).toBe("sent-50");
    expect(sent.conversationExternalId).toBe(
      group ? "iMessage;+;chat123" : "iMessage;-;+14155551212",
    );
    expect(runner.calls.find((c) => c[0] === "send")).toEqual([
      "send",
      group ? "--chat-identifier" : "--to",
      group ? "chat123" : "+14155551212",
      "--text",
      "New text",
      "--service",
      "imessage",
      "--json",
    ]);
  }
});
it("reports uncertain on history timeout and never retries the mutation", async () => {
  const runner = new Runner();
  runner.confirm = false;
  const channel = new IMessageChannel({ runner, confirmationTimeoutMs: 0 });
  await expect(channel.send(target, { text: "New text" })).rejects.toThrow(
    "uncertain",
  );
  expect(runner.calls.filter((c) => c[0] === "send")).toHaveLength(1);
});
it("rejects unsupported attachments before attempting a mutation", async () => {
  const runner = new Runner();
  const channel = new IMessageChannel({ runner });
  await expect(
    channel.send(target, {
      text: "x",
      attachments: [{ url: "https://example.com/x" }],
    }),
  ).rejects.toThrow("local path");
  expect(runner.calls).toEqual([]);
});
it("watch parses NDJSON, reports bad records, restarts with backoff and stops cleanly", async () => {
  vi.useFakeTimers();
  try {
    const runner = new Runner(),
      errors: Error[] = [],
      events: unknown[] = [];
    const channel = new IMessageChannel({ runner, restartBackoffMs: 10 });
    const stop = channel.live(
      (e) => events.push(e),
      (e) => errors.push(e),
    );
    runner.line!(fixture("group").split("\n")[0]);
    runner.line!("not json");
    expect(events).toHaveLength(1);
    expect(errors).toHaveLength(1);
    runner.exit!(new Error("exit"));
    await vi.advanceTimersByTimeAsync(10);
    expect(runner.watchCalls).toBe(2);
    runner.exit!(new Error("exit again"));
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.watchCalls).toBe(2);
    expect(runner.stopped).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
it("rejects malformed records without silently dropping them", () => {
  expect(() => parseImsgJSON("[]")).toThrow("object");
  const channel = new IMessageChannel({ runner: new Runner() });
  expect(() => channel.parseMessage({ id: 1, is_from_me: "false" })).toThrow(
    "Invalid",
  );
});
it("reconciles a live outgoing row that arrives before send confirmation returns", async () => {
  const runner = new Runner();
  const channel = new IMessageChannel({ runner });
  const registry = new ChannelRegistry([channel]);
  const core = new ContactsCore({ path: ":memory:", registry });
  const run = runner.run.bind(runner);
  runner.run = async (args) => {
    const output = await run(args);
    if (args[0] === "send")
      core.ingest(channel.parseMessage(JSON.parse(runner.outgoing(1))));
    return output;
  };
  try {
    const person = core.identity.create({ display_name: "Alice" });
    core.handles.add({
      person_id: person.id,
      channel: "imessage",
      value: target.handle,
      actor: "owner",
      reason: "Exact proof",
    });
    const sent = await core.outbox.send({
      person_id: person.id,
      channel: "imessage",
      text: "New text",
      authorized_by: "owner",
      reason: "Offline test",
      created_by: "test",
    });
    expect(sent.status).toBe("sent");
    expect(
      core.store.one<{ n: number }>("SELECT COUNT(*) n FROM messages")?.n,
    ).toBe(1);
  } finally {
    core.close();
  }
});
it("replays a racing lower-rowid message in the next overlap, without duplicates", async () => {
  const runner = new Runner();
  let directReads = 0;
  const run = runner.run.bind(runner);
  runner.run = async (args) => {
    let output = await run(args);
    if (args[0] === "history" && args[2] === "1" && ++directReads >= 2)
      output +=
        JSON.stringify({
          ...JSON.parse(runner.outgoing(1)),
          id: 100,
          guid: "racing-100",
        }) + "\n";
    if (args[0] === "history" && args[2] === "2")
      output +=
        JSON.stringify({
          ...JSON.parse(runner.outgoing(2)),
          id: 101,
          guid: "racing-101",
        }) + "\n";
    return output;
  };
  const channel = new IMessageChannel({ runner });
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([channel]),
  });
  // Missing/invalid activity conservatively includes chats in this fake.
  runner.run = ((wrapped) => async (args) =>
    args[0] === "chats"
      ? parseImsgJSON(fixture("chats"))
          .map((c) =>
            JSON.stringify({ ...c, last_message_at: new Date().toISOString() }),
          )
          .join("\n")
      : wrapped(args))(runner.run);
  try {
    core.recordSync(
      "imessage",
      "default",
      JSON.stringify({
        version: 1,
        maxRowid: 12,
        lastSync: new Date().toISOString(),
      }),
      null,
    );
    await syncChannel(core, channel);
    expect(JSON.parse(core.syncStatus()[0].cursor!).maxRowid).toBe(101);
    await syncChannel(core, channel);
    await syncChannel(core, channel);
    expect(
      core.store.all("SELECT external_id FROM messages ORDER BY external_id"),
    ).toEqual([{ external_id: "racing-100" }, { external_id: "racing-101" }]);
  } finally {
    core.close();
  }
});
it("a bare sent acknowledgement cannot confirm an old outgoing row", async () => {
  const runner = new Runner();
  runner.confirm = false;
  const run = runner.run.bind(runner);
  runner.run = async (args) =>
    args[0] === "send" ? '{"status":"sent"}' : run(args);
  const channel = new IMessageChannel({ runner, confirmationTimeoutMs: 0 });
  await expect(channel.send(target, { text: "Hello" })).rejects.toThrow(
    "uncertain",
  );
});
it("uses the real process runner offline without invoking imsg", async () => {
  const { ProcessImsgRunner } = await import("../src/channels/imessage.js");
  const runner = new ProcessImsgRunner(process.execPath);
  expect(await runner.run(["-e", 'console.log("offline")'])).toBe("offline\n");
  await expect(
    runner.run(["-e", 'console.error("denied");process.exit(23)']),
  ).rejects.toThrow("denied");
  const lines: string[] = [];
  await new Promise<void>((resolve) => {
    runner.watch(
      ["-e", 'console.log("offline watch")'],
      (line) => lines.push(line),
      () => resolve(),
    );
  });
  expect(lines).toEqual(["offline watch"]);
});
it("a failed outbox entry preserves the uncertain send diagnostic", async () => {
  const runner = new Runner();
  runner.confirm = false;
  const channel = new IMessageChannel({ runner, confirmationTimeoutMs: 0 });
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([channel]),
  });
  try {
    const person = core.identity.create({ display_name: "Alice" });
    core.handles.add({
      person_id: person.id,
      channel: "imessage",
      value: target.handle,
      actor: "owner",
      reason: "Confirmed",
    });
    const result = await core.outbox.send({
      person_id: person.id,
      text: "New text",
      authorized_by: "owner",
      reason: "Test",
      created_by: "test",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("uncertain");
    await expect(
      core.outbox.approve(result.id, "owner", "Retry"),
    ).rejects.toThrow("Only draft");
    expect(runner.calls.filter((c) => c[0] === "send")).toHaveLength(1);
  } finally {
    core.close();
  }
});

const incrementalCursor = (lastSync = "2026-10-12T12:00:00Z", maxRowid = 12) =>
  JSON.stringify({ version: 1, maxRowid, lastSync });
it("selects active chats using last_message_at and reads exactly the --start overlap", async () => {
  const runner = new Runner();
  const run = runner.run.bind(runner);
  runner.run = async (args) => {
    if (args[0] !== "chats") {
      const output = await run(args);
      return args[0] === "history"
        ? runner.filtered(parseImsgJSON(fixture("incremental-group")), args)
        : output;
    }
    runner.calls.push(args);
    return fixture("incremental-chats");
  };
  const channel = new IMessageChannel({ runner });
  const events = await Array.fromAsync(channel.sync(incrementalCursor()));
  expect(events.map((e) => e.external_id)).toEqual(["msg-7"]);
  expect(runner.calls.filter((c) => c[0] === "history")).toEqual([
    [
      "history",
      "--chat-id",
      "2",
      "--limit",
      "2147483647",
      "--start",
      "2026-10-12T11:50:00.000Z",
      "--attachments",
      "--json",
    ],
  ]);
});
it("checkpoints an empty incremental pass without reading inactive history", async () => {
  const runner = new Runner();
  let saved = "";
  const channel = new IMessageChannel({ runner });
  expect(
    await Array.fromAsync(
      channel.sync(incrementalCursor("2026-10-13T00:00:00Z"), (c) => {
        saved = c;
      }),
    ),
  ).toEqual([]);
  expect(runner.calls.map((c) => c[0])).toEqual(["chats"]);
  expect(JSON.parse(saved).lastSync).toBeTruthy();
});
it("does not advance incremental time after a chat read failure; replay is idempotent", async () => {
  const runner = new Runner();
  runner.failChat = "2";
  const channel = new IMessageChannel({ runner });
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([channel]),
  });
  const cursor = incrementalCursor("2026-10-12T11:00:00Z");
  try {
    core.recordSync("imessage", "default", cursor, null);
    await expect(syncChannel(core, channel)).rejects.toThrow(
      "authorization denied",
    );
    expect(core.syncStatus()[0].cursor).toBe(cursor);
    runner.failChat = undefined;
    await syncChannel(core, channel);
    expect(
      core.store.one<{ n: number }>("SELECT COUNT(*) n FROM messages")?.n,
    ).toBe(4);
    expect(JSON.parse(core.syncStatus()[0].cursor!).backfill).toBeUndefined();
  } finally {
    core.close();
  }
});
it("paginates backfill with bounded pages and streams all timestamp ties, resuming a saved page", async () => {
  const runner = new Runner();
  const base = JSON.parse(runner.outgoing(1));
  // More than a page in a single timestamp bucket, plus newer/older messages.
  const rows = Array.from({ length: 1505 }, (_, i) => ({
    ...base,
    id: i + 1,
    guid: `bulk-${i + 1}`,
    created_at:
      i === 0
        ? "2026-10-11T00:00:00Z"
        : i < 1503
          ? "2026-10-12T11:00:00.123Z"
          : "2026-10-12T12:00:00Z",
  }));
  runner.run = async (args) => {
    runner.calls.push(args);
    return args[0] === "chats"
      ? fixture("chats").split("\n")[0]
      : runner.filtered(rows, args);
  };
  const channel = new IMessageChannel({ runner });
  const checkpoints: string[] = [];
  const events = await Array.fromAsync(
    channel.sync(undefined, (c) => checkpoints.push(c)),
  );
  expect(events).toHaveLength(1505);
  expect(new Set(events.map((e) => e.external_id)).size).toBe(1505);
  const progress = JSON.parse(checkpoints[0]);
  expect(progress.backfill).toMatchObject({
    chatId: 1,
    end: "2026-10-12T11:00:00.122Z",
  });
  runner.calls = [];
  const resumed = await Array.fromAsync(channel.sync(checkpoints[0]));
  expect(resumed.map((e) => e.external_id)).toEqual(["bulk-1"]);
  expect(runner.calls.filter((c) => c[0] === "history")).toEqual([
    [
      "history",
      "--chat-id",
      "1",
      "--limit",
      "1000",
      "--end",
      "2026-10-12T11:00:00.122Z",
      "--attachments",
      "--json",
    ],
  ]);
  expect(JSON.parse(checkpoints.at(-1)!).backfill).toBeUndefined();
  expect(JSON.parse(checkpoints.at(-1)!).maxRowid).toBe(1505);
});
it("never checkpoints an incompletely ingested backfill page", async () => {
  const runner = new Runner();
  const channel = new IMessageChannel({ runner });
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([channel]),
  });
  const ingest = core.ingest.bind(core);
  const spy = vi.spyOn(core, "ingest").mockImplementation((e) => {
    if (e.external_id === "msg-2") throw new Error("page interrupted");
    return ingest(e);
  });
  try {
    await expect(syncChannel(core, channel)).rejects.toThrow(
      "page interrupted",
    );
    expect(core.syncStatus()[0].cursor).toBeNull();
    spy.mockRestore();
    await syncChannel(core, channel);
    expect(
      core.store.one<{ n: number }>("SELECT COUNT(*) n FROM messages")?.n,
    ).toBe(4);
  } finally {
    core.close();
  }
});
it("bounds every send-related history read to 100 rows since one minute before send", async () => {
  const runner = new Runner();
  const before = Date.now();
  await new IMessageChannel({ runner }).send(target, { text: "New text" });
  const histories = runner.calls.filter((c) => c[0] === "history");
  expect(histories.length).toBeGreaterThanOrEqual(2);
  for (const args of histories) {
    expect(args[2]).toBe("1");
    expect(args[args.indexOf("--limit") + 1]).toBe("100");
    expect(
      Date.parse(args[args.indexOf("--start") + 1]),
    ).toBeGreaterThanOrEqual(before - 60_000);
    expect(Date.parse(args[args.indexOf("--start") + 1])).toBeLessThanOrEqual(
      Date.now() - 60_000,
    );
  }
});
it("rejects malformed new and legacy cursors before invoking imsg", async () => {
  for (const cursor of [
    "-1",
    "9007199254740992",
    "{}",
    '{"version":1,"maxRowid":0,"lastSync":"bad"}',
  ]) {
    const runner = new Runner();
    await expect(
      Array.fromAsync(new IMessageChannel({ runner }).sync(cursor)),
    ).rejects.toThrow("Invalid imsg cursor");
    expect(runner.calls).toEqual([]);
  }
});
it("streams process output with backpressure and propagates a nonzero exit", async () => {
  const { ProcessImsgRunner } = await import("../src/channels/imessage.js");
  const runner = new ProcessImsgRunner(process.execPath);
  expect(
    await Array.fromAsync(
      runner.stream(["-e", 'console.log("one");console.log("two")']),
    ),
  ).toEqual(["one", "two"]);
  await expect(
    Array.fromAsync(
      runner.stream([
        "-e",
        'console.log("one");console.error("denied");process.exit(23)',
      ]),
    ),
  ).rejects.toThrow("denied");
});

it("includes chats without a usable activity date and does not truncate incremental bursts to the CLI default", async () => {
  const runner = new Runner();
  const base = JSON.parse(runner.outgoing(1));
  const rows = Array.from({ length: 125 }, (_, i) => ({
    ...base,
    id: i + 1,
    guid: `burst-${i}`,
    created_at: "2026-10-12T11:59:00Z",
  }));
  runner.run = async (args) => {
    runner.calls.push(args);
    return args[0] === "chats"
      ? JSON.stringify({ id: 1, guid: base.chat_guid, last_message_at: null })
      : runner.filtered(rows, args);
  };
  expect(
    await Array.fromAsync(
      new IMessageChannel({ runner }).sync(incrementalCursor()),
    ),
  ).toHaveLength(125);
});
