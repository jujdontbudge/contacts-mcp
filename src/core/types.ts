import type { ChannelId, SendContent, SendTarget } from "../channels/channel.js";
export interface Person {
  id: string;
  display_name: string;
  aliases: string[];
  tags: string[];
  notes: string;
  created_at: string;
  updated_at: string;
}
export interface Handle {
  id: string;
  channel: ChannelId;
  value_normalized: string;
  value_raw: string;
  person_id: string | null;
  account_id: string;
  created_at: string;
}
export interface Conversation {
  id: string;
  channel: ChannelId;
  account_id: string;
  external_id: string;
  kind: "direct" | "group";
  title: string | null;
}
export interface Message extends SendContent {
  id: string;
  conversation_id: string;
  channel: ChannelId;
  external_id: string;
  direction: "in" | "out";
  sender_handle_id: string | null;
  sent_at: string;
  raw: unknown;
  ingested_at: string;
}
export interface Outbox {
  id: string;
  status: "draft" | "approved" | "sending" | "sent" | "failed" | "rejected";
  person_id: string;
  conversation_id: string | null;
  handle_id: string;
  channel: ChannelId;
  payload: SendContent;
  authorized_by: string | null;
  reason: string | null;
  created_by: string;
  created_at: string;
  decided_at: string | null;
  sent_message_id: string | null;
  error: string | null;
  reconciled_at: string | null;
  target_snapshot: SendTarget | null;
  send_started_sequence: number | null;
  idempotency_key: string | null;
  inbox_message_id: string | null;
}
export interface SendRequest extends SendContent {
  idempotency_key?: string;
  inbox_message_id?: string;
  claim_token?: string;
  person_id?: string;
  conversation_id?: string;
  handle_id?: string;
  channel?: ChannelId;
  authorized_by?: string;
  reason?: string;
  created_by: string;
}
export interface SendRule {
  id: string;
  scope: "person" | "tag" | "kind";
  value: string;
  channels: ChannelId[];
  created_by: string;
  created_at: string;
  active: number;
  removed_by: string | null;
  removed_at: string | null;
}
