import { EventEmitter } from "node:events";
import BeeperDesktop from "@beeper/desktop-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstagramChannel,
  type BeeperTransport,
} from "../src/channels/instagram.js";
import type { Message } from "@beeper/desktop-api/resources/shared";
import type { SendTarget } from "../src/channels/channel.js";
import {
  accounts,
  direct,
  group,
  messages,
  page,
  upsert,
} from "./fixtures/beeper/data.js";

async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}
async function* iterable<T>(items: T[]) {
  yield* items;
}
const target: SendTarget = {
  channel: "instagram",
  account_id: "ig",
  person_id: "p",
  handle_id: "h",
  handle: "@Alice",
};
function setup() {
  const client = {
    accounts: { list: vi.fn(async () => accounts) },
    chats: {
      list: vi.fn(() => iterable([direct, group])),
      retrieve: vi.fn(async (id: string) => (id === "group" ? group : direct)),
      start: vi.fn(async () => direct),
    },
    messages: {
      list: vi.fn((id: string) =>
        iterable(messages.filter((m) => m.chatID === id).toReversed()),
      ),
      send: vi.fn(async (chatID: string) => ({
        chatID,
        pendingMessageID: "pending",
      })),
      retrieve: vi.fn(
        async (
          _id: string,
          { chatID }: { chatID: string },
        ): Promise<Message> => ({
          ...messages[1],
          chatID,
          id: "sent",
          sendStatus: {
            status: "SUCCESS" as const,
            timestamp: messages[1].timestamp,
          },
        }),
      ),
    },
  } satisfies BeeperTransport;
  return {
    client,
    channel: createInstagramChannel({ client, accountID: "ig" }),
  };
}
class Socket extends EventEmitter {
  send = vi.fn();
  close = vi.fn(() => {
    this.emit("close");
  });
}
afterEach(() => vi.useRealTimers());
describe("Instagram Beeper adapter", () => {
  it("maps direct/group, normalized usernames, direction, metadata, raw, and scoped IDs", async () => {
    const { channel, client } = setup();
    const events = await collect(channel.sync());
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      external_id: '["direct","m1"]',
      account_id: "ig",
      kind: "direct",
      sender: "alice",
      participants: ["owner", "alice"],
      direction: "in",
      sent_at: "2026-10-12T10:00:00.000Z",
      text: "hello",
      attachments: [
        { url: "file:///image.jpg", mimeType: "image/jpeg", name: "image.jpg" },
      ],
    });
    expect(events[0].raw).toEqual({ chat: direct, message: messages[0] });
    expect(events[1]).toMatchObject({
      direction: "out",
      sender: "owner",
      reply_to_external_id: '["direct","m1"]',
    });
    expect(events[2]).toMatchObject({
      external_id: '["group","m1"]',
      kind: "group",
      sender: "bob",
      participants: ["owner", "alice", "bob"],
      text: "",
    });
    expect(client.chats.retrieve).toHaveBeenCalledWith("group", {
      maxParticipantCount: -1,
    });
    expect(channel.capabilities).toEqual({
      startConversation: true,
      groups: true,
      cc: false,
    });
  });
  it("uses SDK HTTP pagination for both chats and messages, with Bearer auth", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer offline",
      );
      let body: unknown;
      if (url.pathname === "/v1/accounts") body = accounts;
      else if (url.pathname === "/v1/chats")
        body = url.searchParams.has("cursor")
          ? page([group])
          : page([direct], "chat-page-2");
      else if (url.pathname.endsWith("/messages"))
        body = url.pathname.includes("group")
          ? page([messages[2]])
          : url.searchParams.has("cursor")
            ? page([messages[0]])
            : page([messages[1]], "message-page-2");
      else body = url.pathname.endsWith("/group") ? group : direct;
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    };
    const client = new BeeperDesktop({
      accessToken: "offline",
      fetch: fetcher,
      maxRetries: 0,
    });
    const channel = createInstagramChannel({ client, accountID: "ig" });
    expect(await collect(channel.sync())).toHaveLength(3);
    expect(calls.some((c) => c.includes("chat-page-2"))).toBe(true);
    expect(calls.some((c) => c.includes("message-page-2"))).toBe(true);
  });
  it("checkpoints only after ingestion and resumes within/between chats without skipping ties", async () => {
    const { client } = setup();
    const checkpoints: string[] = [];
    const channel = createInstagramChannel({
      client,
      accountID: "ig",
      onCursor: (c) => {
        checkpoints.push(c);
      },
    });
    const iterator = channel.sync()[Symbol.asyncIterator]();
    await iterator.next(); // first event is not yet acknowledged
    expect(checkpoints).toHaveLength(0);
    await iterator.next(); // first checkpoint committed; second event not acknowledged
    expect(checkpoints).toHaveLength(1);
    await iterator.return?.();
    const resumed = await collect(channel.sync(checkpoints[0]));
    expect(resumed.map((m) => m.external_id)).toEqual([
      '["direct","m2"]',
      '["group","m1"]',
    ]);
    expect(await collect(channel.sync(channel.getCursor()))).toEqual([]);
    const newChannel = createInstagramChannel({ client, accountID: "ig" });
    expect(await collect(newChannel.sync(channel.getCursor()))).toEqual([]);
    await expect(collect(channel.sync("bad"))).rejects.toThrow();
    const wrong = Buffer.from(
      JSON.stringify({ version: 1, accountID: "wrong", chats: {} }),
    ).toString("base64url");
    await expect(collect(channel.sync(wrong))).rejects.toThrow(
      "cursor/account",
    );
  });
  it("selects only a unique Instagram account and ignores foreign chats", async () => {
    const { client } = setup();
    client.chats.list.mockImplementation(() =>
      iterable([{ ...direct, accountID: "other" }, direct]),
    );
    expect(
      await collect(createInstagramChannel({ client }).sync()),
    ).toHaveLength(2);
    client.accounts.list.mockResolvedValue([
      accounts[0],
      { ...accounts[0], accountID: "ig2" },
    ]);
    await expect(
      collect(createInstagramChannel({ client }).sync()),
    ).rejects.toThrow("Select one");
    await expect(
      collect(createInstagramChannel({ client, accountID: "other" }).sync()),
    ).rejects.toThrow("Select one");
  });
  it("starts an exact DM, then sends and resolves the canonical message ID", async () => {
    const { channel, client } = setup();
    expect(await channel.send(target, { text: "hi" })).toEqual({
      externalId: '["direct","sent"]',
      conversationExternalId: "direct",
    });
    expect(client.chats.start).toHaveBeenCalledWith({
      accountID: "ig",
      user: { username: "alice" },
    });
    expect(client.messages.retrieve).toHaveBeenCalledWith("pending", {
      chatID: "direct",
    });
  });
  it.each([
    { username: "wrong" },
    { username: "Alice", cannotMessage: true },
    { username: undefined },
  ])("refuses unsafe resolved users %j before sending", async (user) => {
    const { channel, client } = setup();
    client.chats.start.mockResolvedValue({
      ...direct,
      participants: {
        ...direct.participants,
        items: [accounts[0].user, { id: "alice", ...user }],
      },
    });
    await expect(channel.send(target, { text: "hi" })).rejects.toThrow(
      "recipient",
    );
    expect(client.messages.send).not.toHaveBeenCalled();
  });
  it("sends to an existing group and translates reply IDs without starting a DM", async () => {
    const { channel, client } = setup();
    await channel.send(
      { ...target, conversationExternalId: "group", conversationKind: "group" },
      { text: "hi", reply_to_external_id: '["group","m1"]' },
    );
    expect(client.chats.start).not.toHaveBeenCalled();
    expect(client.messages.send).toHaveBeenCalledWith("group", {
      text: "hi",
      replyToMessageID: "m1",
    });
    await expect(
      channel.send({ ...target, conversationKind: "group" }, { text: "hi" }),
    ).rejects.toThrow("chat ID");
  });
  it("rejects wrong accounts, read-only/incomplete chats, and unsupported content before writes", async () => {
    const { channel, client } = setup();
    await expect(
      channel.send({ ...target, account_id: "other" }, { text: "hi" }),
    ).rejects.toThrow("account mismatch");
    await expect(
      channel.send(target, { text: "hi", attachments: [{ url: "file:///x" }] }),
    ).rejects.toThrow("text");
    client.chats.start.mockResolvedValue({ ...direct, isReadOnly: true });
    await expect(channel.send(target, { text: "hi" })).rejects.toThrow(
      "read-only",
    );
    client.chats.retrieve.mockResolvedValue({
      ...direct,
      participants: { ...direct.participants, hasMore: true },
    });
    await expect(collect(channel.sync())).rejects.toThrow("incomplete");
    expect(client.messages.send).not.toHaveBeenCalled();
  });
  it("polls pending sends to confirmation, but never repeats writes on timeout/failure", async () => {
    const { client } = setup();
    const channel = createInstagramChannel({
      client,
      accountID: "ig",
      confirmAttempts: 2,
      confirmIntervalMs: 0,
    });
    const pending = {
      ...messages[1],
      id: "pending",
      sendStatus: {
        status: "PENDING" as const,
        timestamp: messages[1].timestamp,
      },
    };
    const confirmed = await client.messages.retrieve("pending", {
      chatID: "direct",
    });
    client.messages.retrieve
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(confirmed);
    expect((await channel.send(target, { text: "hi" })).externalId).toBe(
      '["direct","sent"]',
    );
    client.messages.retrieve.mockResolvedValue(pending);
    await expect(channel.send(target, { text: "hi" })).rejects.toThrow(
      "not confirmed",
    );
    client.messages.retrieve.mockResolvedValue({
      ...pending,
      sendStatus: { status: "FAIL_PERMANENT", timestamp: pending.timestamp },
    });
    await expect(channel.send(target, { text: "hi" })).rejects.toThrow(
      "send failed",
    );
    expect(client.messages.send).toHaveBeenCalledTimes(3);
  });
  it("never retries an uncertain send", async () => {
    const { channel, client } = setup();
    client.messages.retrieve.mockRejectedValue(new Error("not confirmed"));
    await expect(channel.send(target, { text: "hi" })).rejects.toThrow(
      "not confirmed",
    );
    expect(client.messages.send).toHaveBeenCalledTimes(1);
  });
  it("ingests WS entries, filters non-Instagram, reports malformed events, reconnects with backoff and stops", async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const sockets: Socket[] = [];
    const errors: unknown[] = [];
    const factory = vi.fn((url: string, headers: Record<string, string>) => {
      expect(url).toBe("wss://example.test/v1/ws");
      expect(headers.Authorization).toBe("Bearer offline");
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    });
    const channel = createInstagramChannel({
      client,
      accountID: "ig",
      accessToken: "offline",
      baseURL: "https://example.test",
      socketFactory: factory,
      reconnectBaseMs: 10,
      reconnectMaxMs: 25,
      onError: (e) => {
        errors.push(e);
      },
    });
    const ingest = vi.fn();
    const stop = channel.live!(ingest);
    sockets[0].emit("open");
    expect(JSON.parse(sockets[0].send.mock.calls[0][0])).toMatchObject({
      type: "subscriptions.set",
      chatIDs: ["*"],
    });
    sockets[0].emit("message", Buffer.from(JSON.stringify(upsert)));
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ sender: "alice" }),
    );
    client.chats.retrieve.mockResolvedValue({ ...direct, accountID: "other" });
    sockets[0].emit("message", JSON.stringify(upsert));
    sockets[0].emit("message", "invalid");
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(9);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1].emit("error", new Error("offline"));
    await vi.advanceTimersByTimeAsync(19);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    sockets[2].emit("close");
    stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(3);
    expect(sockets[2].close).toHaveBeenCalledTimes(1);
  });
});
