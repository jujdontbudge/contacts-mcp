import BeeperDesktop from "@beeper/desktop-api";
import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import type { Account } from "@beeper/desktop-api/resources/accounts/accounts";
import type {
  Chat,
  ChatListResponse,
  ChatListParams,
  ChatStartParams,
} from "@beeper/desktop-api/resources/chats/chats";
import type { Message, User } from "@beeper/desktop-api/resources/shared";
import type {
  MessageSendParams,
  MessageSendResponse,
} from "@beeper/desktop-api/resources/messages";
import { normalizeHandle, type Channel, type IngestEvent } from "./channel.js";

/** Structural SDK seam: list methods retain SDK auto-pagination. */
export interface BeeperTransport {
  accounts: {
    list(): PromiseLike<Account[]>;
    contacts: {
      search(
        accountID: string,
        query: { query: string },
        options?: { timeout?: number; maxRetries?: number },
      ): PromiseLike<{ items: User[] }>;
    };
  };
  chats: {
    list(query: ChatListParams): AsyncIterable<ChatListResponse>;
    retrieve(
      id: string,
      query: { maxParticipantCount: number },
    ): PromiseLike<Chat>;
    start(body: ChatStartParams): PromiseLike<Chat>;
  };
  messages: {
    list(chatID: string): AsyncIterable<Message>;
    send(
      chatID: string,
      body: MessageSendParams,
    ): PromiseLike<MessageSendResponse>;
    retrieve(id: string, query: { chatID: string }): PromiseLike<Message>;
  };
}
export interface BeeperSocket {
  on(
    event: "open" | "close" | "error" | "message",
    listener: (...args: any[]) => void,
  ): unknown;
  send(data: string): void;
  close(): void;
}
export interface InstagramOptions {
  baseURL?: string;
  accessToken?: string;
  accountID?: string;
  client?: BeeperTransport;
  socketFactory?: (
    url: string,
    headers: Record<string, string>,
  ) => BeeperSocket;
  /** Called after the consumer resumes the generator (i.e. after ingest succeeds). */
  onCursor?: (cursor: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Bounded confirmation reads; writes are never retried. */
  confirmAttempts?: number;
  confirmIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}
interface Position {
  sortKey: string;
  timestamp: string;
}
interface Cursor {
  version: 1;
  accountID: string;
  chats: Record<string, Position>;
}
export interface InstagramChannel extends Channel {
  getCursor(): string | undefined;
}

export function createInstagramChannel(
  opts: InstagramOptions = {},
): InstagramChannel {
  const baseURL =
    opts.baseURL ?? process.env.BEEPER_BASE_URL ?? "http://localhost:23373";
  const token = opts.accessToken ?? process.env.BEEPER_ACCESS_TOKEN;
  if (!token && !opts.client)
    throw new Error("BEEPER_ACCESS_TOKEN is required");
  const client: BeeperTransport =
    opts.client ??
    new BeeperDesktop({ baseURL, accessToken: token!, maxRetries: 0 });
  const confirmAttempts = opts.confirmAttempts ?? 20;
  const confirmIntervalMs = opts.confirmIntervalMs ?? 250;
  if (
    !Number.isInteger(confirmAttempts) ||
    confirmAttempts < 1 ||
    !Number.isFinite(confirmIntervalMs) ||
    confirmIntervalMs < 0
  )
    throw new Error("Invalid send confirmation settings");
  const configured = opts.accountID ?? process.env.BEEPER_INSTAGRAM_ACCOUNT_ID;
  let cursorString: string | undefined;
  async function account(): Promise<Account> {
    const accounts = (await client.accounts.list()).filter(
      (a) => a.network?.toLowerCase() === "instagram",
    );
    const selected = configured
      ? accounts.find((a) => a.accountID === configured)
      : accounts.length === 1
        ? accounts[0]
        : undefined;
    if (!selected)
      throw new Error(
        "Select one Instagram account with BEEPER_INSTAGRAM_ACCOUNT_ID (no unique Instagram account found)",
      );
    return selected;
  }
  const handle = (raw: string) => normalizeHandle("instagram", raw);
  function username(user: User): string {
    if (!user.username)
      throw new Error(
        `Beeper user ${user.id} has no verified username; refusing to infer a handle`,
      );
    return handle(user.username);
  }
  function map(chat: Chat, message: Message, self: Account): IngestEvent {
    if (message.accountID !== self.accountID || message.chatID !== chat.id)
      throw new Error("Beeper message account/chat mismatch");
    const sender =
      message.isSender || message.senderID === self.user.id
        ? self.user
        : chat.participants.items.find((u) => u.id === message.senderID);
    if (!sender) throw new Error(`Unknown Beeper sender ${message.senderID}`);
    return {
      channel: "instagram",
      account_id: self.accountID,
      external_id: external(chat.id, message.id),
      conversation_external_id: chat.id,
      kind: chat.type === "group" ? "group" : "direct",
      title: chat.title,
      // Our own users (the Beeper login and the IG account) are never participants.
      participants: [
        ...new Set(
          chat.participants.items
            .filter((u) => !u.isSelf && u.id !== self.user.id)
            .map(username),
        ),
      ],
      sender: username(sender),
      direction:
        message.isSender || message.senderID === self.user.id ? "out" : "in",
      sent_at: new Date(message.timestamp).toISOString(),
      text: message.text ?? "",
      attachments: message.attachments?.flatMap((a) =>
        a.srcURL || a.id
          ? [{ url: a.srcURL ?? a.id!, mimeType: a.mimeType, name: a.fileName }]
          : [],
      ),
      reply_to_external_id: message.linkedMessageID
        ? external(chat.id, message.linkedMessageID)
        : undefined,
      raw: { chat, message },
    };
  }
  async function fullChat(id: string): Promise<Chat> {
    const chat = await client.chats.retrieve(id, { maxParticipantCount: -1 });
    if (chat.participants.hasMore)
      throw new Error("Beeper returned incomplete participants");
    if (chat.merge)
      throw new Error("Use an Instagram member chat, not a merged chat");
    return chat;
  }
  return {
    id: "instagram",
    capabilities: { startConversation: true, groups: true, cc: false },
    normalizeHandle: handle,
    getCursor: () => cursorString,
    async *sync(encoded) {
      const self = await account();
      const state = decodeCursor(encoded, self.accountID);
      cursorString = encodeCursor(state);
      for await (const listed of client.chats.list({
        accountIDs: [self.accountID],
      })) {
        if (listed.accountID !== self.accountID || listed.merge) continue;
        const chat = await fullChat(listed.id);
        if (chat.accountID !== self.accountID)
          throw new Error("Beeper chat account mismatch");
        // Scan API-visible history: API pagination tokens are opaque, not message sort keys.
        // Emit oldest first so a checkpoint can never skip unconsumed older messages.
        const messages: Message[] = [];
        for await (const message of client.messages.list(chat.id))
          messages.push(message);
        messages.sort((a, b) => compare(a, b));
        for (const message of messages) {
          const previous = state.chats[chat.id];
          if (previous && compare(message, previous) <= 0) continue;
          yield map(chat, message, self);
          state.chats[chat.id] = {
            sortKey: message.sortKey,
            timestamp: message.timestamp,
          };
          cursorString = encodeCursor(state);
          await opts.onCursor?.(cursorString);
        }
      }
    },
    async send(target, content) {
      if (target.channel !== "instagram") throw new Error("Wrong channel");
      if (content.metadata?.instagram_tag)
        throw new Error("HUMAN_AGENT requires the official transport");
      if (
        content.attachments?.length ||
        content.email_cc?.length ||
        content.email_bcc?.length ||
        content.email_to?.length ||
        content.subject
      )
        throw new Error("Instagram sends support text and replies only");
      const self = await account();
      if (target.account_id !== self.accountID)
        throw new Error("Instagram target account mismatch");
      if (!target.conversationExternalId && target.conversationKind === "group")
        throw new Error("Group sends require a chat ID");
      const requested = handle(target.handle);
      let chat: Chat;
      if (target.conversationExternalId)
        chat = await fullChat(target.conversationExternalId);
      else {
        // Prefer an existing direct chat with this username: Beeper's contact
        // search can hang for minutes, while chats opened in Beeper are instant.
        let existing: Chat | undefined;
        let scanned = 0;
        for await (const c of client.chats.list({
          accountIDs: [self.accountID],
        } as ChatListParams)) {
          if (++scanned > 300) break;
          if (c.type !== "single") continue;
          const full = await fullChat(c.id);
          if (
            full.participants.items.some(
              (u) => !u.isSelf && !!u.username && username(u) === requested,
            )
          ) {
            existing = full;
            break;
          }
        }
        if (existing) chat = existing;
        else {
          let items: User[];
          try {
            ({ items } = await client.accounts.contacts.search(
              self.accountID,
              { query: `@${requested}` },
              { timeout: 180_000, maxRetries: 0 },
            ));
          } catch {
            throw new Error(
              "Instagram contact lookup failed or timed out (180s); verify Beeper connectivity and retry lookup",
            );
          }
          const matches = items.filter(
            (u) => u.username && username(u) === requested && !u.isSelf,
          );
          if (
            matches.length !== 1 ||
            !matches[0].id ||
            matches[0].cannotMessage
          )
            throw new Error(
              "Instagram contact lookup requires one messageable exact username match",
            );
          chat = await client.chats.start({
            accountID: self.accountID,
            user: { id: matches[0].id },
          });
        }
      }
      if (
        chat.accountID !== self.accountID ||
        chat.merge ||
        chat.isReadOnly ||
        chat.participants.hasMore
      )
        throw new Error("Unsafe or read-only Beeper chat");
      if (!target.conversationExternalId && chat.type !== "single")
        throw new Error("Expected a direct chat");
      if (chat.type === "single") {
        const recipients = chat.participants.items.filter(
          (u) => !u.isSelf && u.id !== self.user.id,
        );
        if (
          recipients.length !== 1 ||
          !recipients[0].username ||
          username(recipients[0]) !== requested ||
          recipients[0].cannotMessage
        )
          throw new Error(
            "Resolved Instagram recipient mismatch or cannotMessage",
          );
      }
      const sendStartedAt = Date.now();
      const sent = await client.messages.send(chat.id, {
        text: content.text,
        replyToMessageID: content.reply_to_external_id
          ? remoteID(chat.id, content.reply_to_external_id)
          : undefined,
      });
      if (sent.chatID !== chat.id)
        throw new Error(
          "Beeper unexpectedly routed send to another chat; reconcile manually",
        );
      // Never re-send an uncertain write. Resolve the pending ID to a stable ID.
      for (let attempt = 0; attempt < confirmAttempts; attempt++) {
        if (attempt) await delay(confirmIntervalMs);
        let message: Message;
        try {
          message = await client.messages.retrieve(sent.pendingMessageID, {
            chatID: sent.chatID,
          });
        } catch (error) {
          if (error instanceof BeeperDesktop.APIError && error.status === 404) {
            // Beeper swaps the pending ID for the network's final ID once delivered,
            // after which the pending ID 404s. Find our message in the chat instead.
            let scanned = 0;
            for await (const m of client.messages.list(chat.id)) {
              if (++scanned > 20) break;
              if (
                m.isSender &&
                m.text === content.text &&
                Date.parse(m.timestamp) >= sendStartedAt - 60_000 &&
                m.sendStatus?.status !== "FAIL_PERMANENT" &&
                m.sendStatus?.status !== "FAIL_RETRIABLE"
              )
                return {
                  externalId: external(chat.id, m.id),
                  conversationExternalId: chat.id,
                };
            }
            continue;
          }
          throw error;
        }
        if (message.chatID !== chat.id || message.accountID !== self.accountID)
          throw new Error("Beeper confirmation account/chat mismatch");
        if (
          message.sendStatus?.status === "FAIL_PERMANENT" ||
          message.sendStatus?.status === "FAIL_RETRIABLE"
        )
          throw new Error(
            "Instagram send failed; reconcile manually before retrying",
          );
        // Beeper omits sendStatus once a message is delivered: a final network ID
        // (different from the pending one) without a failure status means sent.
        if (
          message.id !== sent.pendingMessageID &&
          (message.sendStatus == null ||
            message.sendStatus.status === "SUCCESS")
        )
          return {
            externalId: external(chat.id, message.id),
            conversationExternalId: chat.id,
          };
      }
      throw new Error(
        `Instagram send not confirmed (pending ID ${sent.pendingMessageID}); reconcile manually`,
      );
    },
    live(onEvent) {
      if (!token && !opts.socketFactory)
        throw new Error("BEEPER_ACCESS_TOKEN is required for live events");
      let stopped = false;
      let socket: BeeperSocket | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      let queue = Promise.resolve();
      const url = new URL(baseURL);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/ws`;
      const report = (error: unknown) => opts.onError?.(error);
      const retry = () => {
        if (stopped || timer) return;
        const delay = Math.min(
          (opts.reconnectBaseMs ?? 1000) * 2 ** Math.min(attempt++, 16),
          opts.reconnectMaxMs ?? 30000,
        );
        timer = setTimeout(() => {
          timer = undefined;
          connect();
        }, delay);
      };
      const connect = () => {
        if (stopped) return;
        try {
          const current = (
            opts.socketFactory ??
            ((u, headers) => new WebSocket(u, { headers }))
          )(url.toString(), { Authorization: `Bearer ${token ?? ""}` });
          socket = current;
          current.on("open", () => {
            if (!stopped)
              current.send(
                JSON.stringify({
                  type: "subscriptions.set",
                  requestID: "instagram-all",
                  chatIDs: ["*"],
                }),
              );
          });
          current.on("close", retry);
          current.on("error", (e) => {
            report(e);
            current.close();
            retry();
          });
          current.on("message", (data) => {
            queue = queue
              .then(async () => {
                if (stopped) return;
                const event = JSON.parse(data.toString());
                if (event.type === "ready") {
                  attempt = 0;
                  return;
                }
                if (
                  event.type !== "message.upserted" ||
                  typeof event.chatID !== "string"
                )
                  return;
                const self = await account();
                const chat = await fullChat(event.chatID);
                if (chat.accountID !== self.accountID) return;
                for (const message of event.entries ?? []) {
                  const mapped = map(chat, message, self);
                  if (!stopped) onEvent(mapped);
                }
              })
              .catch(report);
          });
        } catch (error) {
          report(error);
          retry();
        }
      };
      connect();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        socket?.close();
      };
    },
  };
}
function external(chatID: string, messageID: string): string {
  return JSON.stringify([chatID, messageID]);
}
function remoteID(chatID: string, id: string): string {
  const pair: unknown = JSON.parse(id);
  if (
    !Array.isArray(pair) ||
    pair.length !== 2 ||
    pair[0] !== chatID ||
    typeof pair[1] !== "string"
  )
    throw new Error("Reply ID must belong to this Instagram chat");
  return pair[1];
}
function compare(a: Position, b: Position): number {
  const time = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  if (!Number.isFinite(time)) throw new Error("Invalid Beeper timestamp");
  if (time) return time;
  if (/^\d+$/.test(a.sortKey) && /^\d+$/.test(b.sortKey))
    return BigInt(a.sortKey) < BigInt(b.sortKey)
      ? -1
      : BigInt(a.sortKey) > BigInt(b.sortKey)
        ? 1
        : 0;
  return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
}
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function decodeCursor(encoded: string | undefined, accountID: string): Cursor {
  if (!encoded) return { version: 1, accountID, chats: Object.create(null) };
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString());
  if (
    value.version !== 1 ||
    value.accountID !== accountID ||
    !value.chats ||
    typeof value.chats !== "object" ||
    Array.isArray(value.chats)
  )
    throw new Error("Invalid Instagram cursor/account");
  for (const position of Object.values(value.chats) as Position[])
    if (
      !position ||
      typeof position.sortKey !== "string" ||
      !Number.isFinite(Date.parse(position.timestamp))
    )
      throw new Error("Invalid Instagram cursor position");
  value.chats = Object.assign(Object.create(null), value.chats);
  return value;
}
