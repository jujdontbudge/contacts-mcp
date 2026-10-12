import { ulid } from "ulid";
import {
  normalizeHandle,
  type Channel,
  type ChannelId,
  type IngestEvent,
  type SendContent,
  type SendTarget,
} from "./channel.js";
export class FakeChannel implements Channel {
  readonly sent: {
    target: SendTarget;
    content: SendContent;
    externalId: string;
  }[] = [];
  events: IngestEvent[] = [];
  constructor(
    public id: ChannelId = "imessage",
    public capabilities: Channel["capabilities"] = {
      startConversation: id !== "tiktok",
      groups: id !== "tiktok",
      cc: id === "email",
      ...(id === "tiktok" ? { replyWindowHours: 48 } : {}),
    },
  ) {}
  normalizeHandle(raw: string): string {
    return normalizeHandle(this.id, raw);
  }
  async *sync(_cursor?: string): AsyncIterable<IngestEvent> {
    yield* this.events;
  }
  async send(target: SendTarget, content: SendContent) {
    const externalId = `fake_${ulid()}`;
    this.sent.push({ target, content, externalId });
    return {
      externalId,
      conversationExternalId:
        target.conversationExternalId ?? `fake_chat_${ulid()}`,
    };
  }
}
