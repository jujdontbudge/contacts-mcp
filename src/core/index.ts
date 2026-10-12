import { openDatabase } from "./db.js";
import { Store } from "./store.js";
import { Identity } from "./identity.js";
import { Handles } from "./handles.js";
import { Conversations } from "./conversations.js";
import { Resolver } from "./resolver.js";
import { Authorization } from "./authorization.js";
import { OutboxService } from "./outbox.js";
import { ChannelRegistry } from "../channels/registry.js";
import type { ChannelId, IngestEvent } from "../channels/channel.js";
export class ContactsCore {
  readonly store: Store;
  readonly identity: Identity;
  readonly handles: Handles;
  readonly conversations: Conversations;
  readonly resolver: Resolver;
  readonly authorization: Authorization;
  readonly outbox: OutboxService;
  constructor(
    options: {
      path?: string;
      registry?: ChannelRegistry;
      clock?: () => Date;
      rateLimits?: Partial<Record<ChannelId, number>>;
    } = {},
  ) {
    const registry = options.registry ?? new ChannelRegistry();
    this.store = new Store(openDatabase(options.path), options.clock);
    this.identity = new Identity(this.store);
    this.handles = new Handles(this.store, this.identity, registry);
    this.conversations = new Conversations(this.store, this.handles);
    this.resolver = new Resolver(this.identity, this.conversations);
    this.authorization = new Authorization(this.store);
    const rates: Partial<Record<ChannelId, number>> = {
      instagram: 20,
      ...options.rateLimits,
    };
    for (const c of ["imessage", "instagram", "email", "tiktok"] as const) {
      const value = process.env[`CONTACTS_RATE_LIMIT_${c.toUpperCase()}`];
      if (value !== undefined) rates[c] = Number(value);
      const limit = rates[c];
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0))
        throw new Error(`Invalid rate limit for ${c}`);
    }
    this.outbox = new OutboxService(
      this.store,
      this.identity,
      this.handles,
      this.conversations,
      this.authorization,
      registry,
      rates,
    );
  }
  ingest(event: IngestEvent) {
    return this.store.db.transaction(() => {
      const message = this.conversations.ingest(event);
      for (const raw of [event.sender, ...(event.participants ?? [])]) {
        const handle = this.handles.ensure(
          event.channel,
          event.account_id,
          raw,
        );
        if (handle.person_id) continue;
        for (const candidate of this.resolver
          .find(raw)
          .candidates.filter((c) => c.score >= 0.3)) {
          this.handles.suggest(
            handle.id,
            candidate.id,
            `Similarity to stored identity (${raw}); requires explicit exact proof`,
            candidate.score,
          );
        }
      }
      return message;
    })();
  }
  ensureSyncState(channel: ChannelId, account = "default"): void {
    this.store.run(
      "INSERT OR IGNORE INTO sync_state(channel,account_id) VALUES (?,?)",
      channel,
      account,
    );
  }
  ingestSynced(event: IngestEvent, cursor: string | null): void {
    this.store.db.transaction(() => {
      this.ingest(event);
      this.ensureSyncState(event.channel, event.account_id);
      this.store.run(
        "UPDATE sync_state SET cursor=? WHERE channel=? AND account_id=?",
        cursor,
        event.channel,
        event.account_id,
      );
    })();
  }
  recordSync(
    channel: ChannelId,
    account: string,
    cursor: string | null,
    error: string | null,
  ): void {
    this.ensureSyncState(channel, account);
    this.store.run(
      "UPDATE sync_state SET cursor=COALESCE(?,cursor),last_ok_at=CASE WHEN ? IS NULL THEN ? ELSE last_ok_at END,last_error=? WHERE channel=? AND account_id=?",
      cursor,
      error,
      this.store.now(),
      error,
      channel,
      account,
    );
  }
  syncStatus() {
    return this.store.all<{
      channel: ChannelId;
      account_id: string;
      cursor: string | null;
      last_ok_at: string | null;
      last_error: string | null;
    }>("SELECT * FROM sync_state");
  }
  close(): void {
    this.store.db.close();
  }
}
export type {
  Channel,
  ChannelId,
  IngestEvent,
  SendContent,
  SendTarget,
} from "../channels/channel.js";
