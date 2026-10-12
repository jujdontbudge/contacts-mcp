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
      return (
        fixture(args[2] === "1" ? "direct" : "group") +
        (this.sent && this.confirm ? `${this.outgoing(Number(args[2]))}\n` : "")
      );
    }
    throw new Error("Unexpected command");
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
it("maps documented direct/group, email, outgoing, attachments and missing sender into unlinked handles", async () => {
  const channel = new IMessageChannel({ runner: new Runner() });
  const events = await Array.fromAsync(channel.sync());
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
it("resumes a durable globally ordered cursor, including after a partial ingest failure", async () => {
  const channel = new IMessageChannel({ runner: new Runner() });
  expect(
    (await Array.fromAsync(channel.sync("5"))).map((e) => e.external_id),
  ).toEqual(["msg-7", "msg-12"]);
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
      cursor: "5",
      last_error: "disk failure",
      last_ok_at: null,
    });
    spy.mockRestore();
    await syncChannel(core, channel);
    expect(core.syncStatus()[0]).toMatchObject({
      cursor: "12",
      last_error: null,
    });
    expect(
      core.store.one<{ n: number }>("SELECT COUNT(*) n FROM messages")?.n,
    ).toBe(4);
  } finally {
    core.close();
  }
});
it("does not checkpoint any chat when another chat read fails", async () => {
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
    expect(core.syncStatus()[0].cursor).toBeNull();
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
it("does not skip a new message in an already-scanned chat when another chat advances the cursor", async () => {
  const runner = new Runner();
  let directReads = 0;
  const run = runner.run.bind(runner);
  runner.run = async (args) => {
    let output = await run(args);
    if (args[0] === "history" && args[2] === "1") {
      directReads++;
      if (directReads >= 2)
        output +=
          JSON.stringify({
            ...JSON.parse(runner.outgoing(1)),
            id: 100,
            guid: "racing-100",
          }) + "\n";
    }
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
  expect(
    (await Array.fromAsync(channel.sync("12"))).map((e) => e.external_id),
  ).toEqual(["racing-100", "racing-101"]);
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
