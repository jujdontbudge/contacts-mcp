import { parsePhoneNumberFromString } from "libphonenumber-js";
export type ChannelId = "imessage" | "instagram" | "email" | "tiktok" | "sideshift";
export interface SendContent {
  text: string;
  subject?: string;
  email_to?: string[];
  email_cc?: string[];
  email_bcc?: string[];
  attachments?: { url: string; mimeType?: string; name?: string }[];
  reply_to_external_id?: string;
  kind?: string;
  metadata?: { instagram_tag?: "HUMAN_AGENT"; sideshift_job_id?: string };
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
export interface HandleProfile {
  channel: ChannelId;
  account_id: string;
  value: string;
  display_name?: string;
  profile_url?: string;
  profile_image_url?: string;
  job_ids?: string[];
  related_handles?: { channel: ChannelId; value: string }[];
}
export interface IngestEvent {
  handle_profiles?: HandleProfile[];
  channel: ChannelId;
  account_id: string;
  external_id: string;
  conversation_external_id: string;
  kind?: "direct" | "group";
  title?: string;
  participants?: string[];
  /** Proven sending-account aliases, used to repair legacy participant pollution. */
  own_handles?: string[];
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
  /** The account whose sync cursor this adapter consumes. */
  accountId?: string;
  /** Resolve a configured/unique account before taking its durable sync lease. */
  resolveAccountId?(): Promise<string>;
  getCursor?(): string | undefined;
  /** Safe diagnostics for a completed pass that skipped individual records. */
  getSyncWarning?(): string | undefined;
  /** Identity discovery without fabricating messages or conversations. */
  syncProfiles?(cursor?: string): AsyncIterable<HandleProfile>;
  /** Bounded background maintenance, e.g. refresh credentials when due. */
  maintenance?(): Promise<void>;
  capabilities: {
    startConversation: boolean;
    groups: boolean;
    cc: boolean;
    replyWindowHours?: number;
  };
  // An adapter may checkpoint a completed segment after its yielded events
  // have been consumed. Failed/incomplete segments must remain replayable.
  sync(
    cursor?: string,
    checkpoint?: (cursor: string) => void,
  ): AsyncIterable<IngestEvent>;
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
  if (channel === "sideshift") return value; // Opaque creator IDs are case-sensitive.
  if ((channel === "tiktok" && /^tiktok:(user|account):/.test(value)) ||
      (channel === "instagram" && /^(beeper:user:|igsid:)/.test(value))) return value;
  if (channel === "imessage" && !value.includes("@")) {
    const phone = parsePhoneNumberFromString(value, { defaultCountry: "US", extract: false });
    if (!phone?.isValid() || phone.ext)
      throw new Error("Invalid phone number; provide E.164 or a US number");
    return phone.number;
  }
  return value
    .toLowerCase()
    .replace(channel === "instagram" || channel === "tiktok" ? /^@/ : /$^/, "");
}
