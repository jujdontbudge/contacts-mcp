import { parsePhoneNumberFromString } from "libphonenumber-js";
export type ChannelId = "imessage" | "instagram" | "email" | "tiktok";
export interface SendContent {
  text: string;
  subject?: string;
  email_to?: string[];
  email_cc?: string[];
  email_bcc?: string[];
  attachments?: { url: string; mimeType?: string; name?: string }[];
  reply_to_external_id?: string;
  kind?: string;
}
export interface SendTarget {
  person_id: string;
  handle_id: string;
  handle: string;
  channel: ChannelId;
  account_id: string;
  conversation_id?: string;
  conversationExternalId?: string;
  conversationKind?: "direct" | "group";
}
export interface IngestEvent {
  channel: ChannelId;
  account_id: string;
  external_id: string;
  conversation_external_id: string;
  kind?: "direct" | "group";
  title?: string;
  participants?: string[];
  sender: string;
  direction: "in" | "out";
  sent_at: string;
  text: string;
  subject?: string;
  email_to?: string[];
  email_cc?: string[];
  email_bcc?: string[];
  attachments?: SendContent["attachments"];
  reply_to_external_id?: string;
  raw?: unknown;
}
export interface Channel {
  id: ChannelId;
  capabilities: {
    startConversation: boolean;
    groups: boolean;
    cc: boolean;
    replyWindowHours?: number;
  };
  sync(cursor?: string): AsyncIterable<IngestEvent>;
  live?(
    onEvent: (e: IngestEvent) => void,
    onError?: (error: Error) => void,
  ): () => void;
  send(
    target: SendTarget,
    content: SendContent,
  ): Promise<{ externalId: string; conversationExternalId: string }>;
  normalizeHandle(raw: string): string;
}
export function normalizeHandle(channel: ChannelId, raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Handle cannot be empty");
  if (channel === "imessage" && !value.includes("@")) {
    const phone = parsePhoneNumberFromString(value, "US");
    if (!phone?.isValid())
      throw new Error("Invalid phone number; provide E.164 or a US number");
    return phone.number;
  }
  return value
    .toLowerCase()
    .replace(channel === "instagram" || channel === "tiktok" ? /^@/ : /$^/, "");
}
