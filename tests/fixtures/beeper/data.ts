import type { Account } from "@beeper/desktop-api/resources/accounts/accounts";
import type { Chat } from "@beeper/desktop-api/resources/chats/chats";
import type { Message } from "@beeper/desktop-api/resources/shared";
// Synthetic fixtures checked against the pinned SDK's public types; no personal data.
export const accounts: Account[] = [
  {
    accountID: "ig",
    network: "Instagram",
    bridge: { id: "instagram", type: "instagram", provider: "cloud" },
    status: "connected",
    user: { id: "self", username: "@Owner", isSelf: true },
  },
  {
    accountID: "other",
    network: "WhatsApp",
    bridge: { id: "whatsapp", type: "whatsapp", provider: "local" },
    status: "connected",
    user: { id: "other-self" },
  },
];
export const direct: Chat = {
  id: "direct",
  accountID: "ig",
  network: "Instagram",
  type: "single",
  title: "Alice",
  unreadCount: 1,
  participants: {
    hasMore: false,
    total: 2,
    items: [accounts[0].user, { id: "alice", username: "@Alice" }],
  },
};
export const group: Chat = {
  ...direct,
  id: "group",
  type: "group",
  title: "Gym",
  participants: {
    hasMore: false,
    total: 3,
    items: [...direct.participants.items, { id: "bob", username: "BOB" }],
  },
};
export const messages: Message[] = [
  {
    id: "m1",
    accountID: "ig",
    chatID: "direct",
    senderID: "alice",
    sortKey: "9",
    timestamp: "2026-10-12T10:00:00Z",
    text: "hello",
    attachments: [
      {
        type: "img",
        id: "mxc://image",
        srcURL: "file:///image.jpg",
        fileName: "image.jpg",
        mimeType: "image/jpeg",
        fileSize: 32,
        size: { width: 100, height: 100 },
      },
    ],
  },
  {
    id: "m2",
    accountID: "ig",
    chatID: "direct",
    senderID: "self",
    isSender: true,
    sortKey: "10",
    timestamp: "2026-10-12T10:00:00Z",
    text: "hi",
    linkedMessageID: "m1",
  },
  {
    id: "m1",
    accountID: "ig",
    chatID: "group",
    senderID: "bob",
    sortKey: "11",
    timestamp: "2026-10-12T11:00:00Z",
  },
];
export const upsert = {
  type: "message.upserted",
  seq: 1,
  ts: 1791800000000,
  chatID: "direct",
  ids: ["m1"],
  entries: [messages[0]],
};
export function page<T>(items: T[], oldestCursor: string | null = null) {
  return {
    items,
    hasMore: oldestCursor !== null,
    oldestCursor,
    newestCursor: null,
  };
}
