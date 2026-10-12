import type { Channel, IngestEvent, SendTarget } from "./channel.js";
import { officialMessageId, type InstagramOfficialChannel } from "./instagram-official.js";

export interface InstagramBothOptions {
  getLastInboundAt?: (target: SendTarget) => string | undefined;
  /** Only supply a provider-proven Meta ID, never a text/time fingerprint. */
  getPlatformMessageId?: (event: IngestEvent) => string | undefined;
  clock?: () => Date;
}
/** Composition only: each child owns its API decisions and independent cursor. */
export function createInstagramBothChannel(beeper: Channel, official: InstagramOfficialChannel, opts: InstagramBothOptions = {}): InstagramOfficialChannel {
  if (beeper.accountId !== official.accountId) throw new Error("Both Instagram transports must share a logical account");
  let state: { version: 1; beeper?: string; official?: string } = { version: 1 };
  let cursor: string | undefined;
  const clock = opts.clock ?? (() => new Date());
  async function map(event: IngestEvent): Promise<IngestEvent> {
    const mid = opts.getPlatformMessageId?.(event);
    return mid ? { ...event, external_id: officialMessageId(await official.resolveUserId(), mid), raw: { ...(event.raw as object), contacts_platform_message_id: mid } } : event;
  }
  return {
    id: "instagram", accountId: beeper.accountId,
    capabilities: { startConversation: true, groups: true, cc: false },
    normalizeHandle: beeper.normalizeHandle,
    getCursor: () => cursor,
    resolveUserId: official.resolveUserId,
    refreshAccessToken: official.refreshAccessToken,
    maintenance: official.maintenance,
    handleWebhook: official.handleWebhook,
    async *sync(encoded, checkpoint) {
      if (encoded) {
        const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString());
        if (parsed.version === 1 && parsed.accountID && parsed.chats) {
          // Switching from the default Beeper transport retains its history position.
          state = { version: 1, beeper: encoded };
        } else {
          if (parsed.version !== 1 || (parsed.beeper !== undefined && typeof parsed.beeper !== "string") || (parsed.official !== undefined && typeof parsed.official !== "string") || parsed.userId) throw new Error("Invalid combined Instagram cursor");
          state = parsed;
        }
      } else state = { version: 1 };
      const save = () => { cursor = Buffer.from(JSON.stringify(state)).toString("base64url"); checkpoint?.(cursor); };
      // No naked child checkpoints may enter the shared sync_state row.
      const errors: string[] = [];
      for (const [key, child] of [["beeper", beeper], ["official", official]] as const) {
        try {
          for await (const event of child.sync(state[key], next => { state[key] = next; save(); })) yield key === "beeper" ? await map(event) : event;
          state[key] = child.getCursor?.() ?? state[key];
          save();
        } catch (error) { errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (errors.length) throw new Error(errors.join("; "));
    },
    live(onEvent, onError) {
      return beeper.live?.(event => { void map(event).then(onEvent).catch(error => onError?.(error)); }, onError) ?? (() => {});
    },
    async send(target, content) {
      const human = content.metadata?.instagram_tag === "HUMAN_AGENT";
      if (target.conversationKind === "group") {
        if (human) throw new Error("HUMAN_AGENT requires the official transport");
        return beeper.send(target, content);
      }
      const officialThread = target.conversationExternalId?.startsWith("ig:");
      const last = opts.getLastInboundAt?.(target);
      // New/cold DMs (including Beeper threads with no inbound) use Desktop.
      if (!officialThread && !last) {
        if (human) throw new Error("HUMAN_AGENT cannot start conversations");
        if (target.handle.startsWith("igsid:")) throw new Error("Beeper cold starts require a verified username handle");
        return beeper.send(target, content);
      }
      const age = last ? clock().getTime() - Date.parse(last) : undefined;
      if (age !== undefined && (age < 0 || !Number.isFinite(age) || age >= (human ? 168 : 24) * 3600000)) throw new Error("Instagram reply window is closed");
      // Official resolves the peer by proven IGSID/username and rechecks current API history.
      // Never fall back after an official refusal/uncertain write.
      return official.send(target, content);
    },
  };
}
