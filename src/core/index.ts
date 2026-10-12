import { openDatabase } from "./db.js";
import { Store } from "./store.js";
import { Identity } from "./identity.js";
import { Handles } from "./handles.js";
import { Conversations } from "./conversations.js";
import { Resolver } from "./resolver.js";
import { Authorization } from "./authorization.js";
import { OutboxService, type DispatchHooks } from "./outbox.js";
import { ChannelRegistry } from "../channels/registry.js";
import type { ChannelId, IngestEvent } from "../channels/channel.js";
export class ContactsCore {
  readonly store: Store;
  readonly identity: Identity;
  readonly handles: Handles;
  readonly conversations: Conversations;
  readonly resolver: Resolver;
  readonly authorization: Authorization;
  private readonly registry: ChannelRegistry;
  readonly outbox: OutboxService;
  constructor(
    options: {
      path?: string;
      registry?: ChannelRegistry;
      clock?: () => Date;
      dispatchHooks?: DispatchHooks;
      env?: NodeJS.ProcessEnv;
      rateLimits?: Partial<Record<ChannelId, number>>;
    } = {},
  ) {
    const registry = options.registry ?? new ChannelRegistry();
    this.registry = registry;
    this.store = new Store(openDatabase(options.path), options.clock);
    this.identity = new Identity(this.store);
    this.handles = new Handles(this.store, this.identity, registry);
    this.conversations = new Conversations(this.store, this.handles);
    this.resolver = new Resolver(this.identity, this.conversations);
    this.authorization = new Authorization(this.store);
    const rates: Partial<Record<ChannelId, number>> = {
      instagram: 20,
      tiktok: 10,
      imessage: 60,
      email: 60,
      ...options.rateLimits,
    };
    for (const c of ["imessage", "instagram", "email", "tiktok"] as const) {
      const value = (options.env ?? process.env)[
        `CONTACTS_RATE_LIMIT_${c.toUpperCase()}`
      ];
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
      options.dispatchHooks,
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
  /** Private credential storage; deliberately excluded from every MCP tool/status response. */
  loadChannelToken(channel: ChannelId, account: string): { accessToken: string; refreshedAt: string } | undefined {
    const row = this.store.one<{ access_token: string; refreshed_at: string }>(
      "SELECT access_token,refreshed_at FROM channel_secrets WHERE channel=? AND account_id=?", channel, account,
    );
    return row ? { accessToken: row.access_token, refreshedAt: row.refreshed_at } : undefined;
  }
  saveChannelToken(channel: ChannelId, account: string, token: { accessToken: string; refreshedAt: string }): void {
    this.store.run(
      "INSERT INTO channel_secrets VALUES (?,?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET access_token=excluded.access_token,refreshed_at=excluded.refreshed_at",
      channel, account, token.accessToken, token.refreshedAt,
    );
  }
  lastInboundAt(channel: ChannelId, account: string, external: string): string | undefined {
    return this.store.one<{ sent_at: string }>(
      "SELECT m.sent_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.channel=? AND c.account_id=? AND c.external_id=? AND m.direction='in' ORDER BY m.sent_at DESC LIMIT 1",
      channel, account, external,
    )?.sent_at;
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
  checkpointSync(channel: ChannelId, account: string, cursor: string): void {
    this.ensureSyncState(channel, account);
    this.store.run(
      "UPDATE sync_state SET cursor=? WHERE channel=? AND account_id=?",
      cursor,
      channel,
      account,
    );
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
    const rows = this.store.all<{
      channel: ChannelId;
      account_id: string;
      cursor: string | null;
      last_ok_at: string | null;
      last_error: string | null;
    }>("SELECT * FROM sync_state");
    const result = rows.map((row) => ({
      ...row,
      status: this.registry.disabled.has(row.channel) ? "disabled" : "enabled",
      disabled_reason: this.registry.disabled.get(row.channel)?.reason ?? null,
    }));
    for (const [channel, disabled] of this.registry.disabled) {
      if (!rows.some((row) => row.channel === channel))
        result.push({
          channel,
          account_id: disabled.account_id,
          cursor: null,
          last_ok_at: null,
          last_error: null,
          status: "disabled",
          disabled_reason: disabled.reason,
        });
    }
    return result;
  }
  /** Storage stays in core; composition decides when a provider event is safe to reconcile. */
  stageOutgoing(outboxId: string, event: IngestEvent): void {
    const outbox = this.outbox.get(outboxId);
    if (event.direction !== "out" || event.channel !== outbox.channel)
      throw new Error("Staged event does not match outgoing dispatch");
    this.store.run(
      "INSERT INTO staged_outgoing VALUES (?,?) ON CONFLICT(outbox_id) DO UPDATE SET payload=excluded.payload",
      outboxId,
      JSON.stringify(event),
    );
  }
  reconcileOutgoing(): void {
    this.store.db.transaction(() => {
      for (const row of this.store.all<{
        outbox_id: string;
        payload: IngestEvent;
      }>(
        "SELECT s.* FROM staged_outgoing s JOIN outbox o ON o.id=s.outbox_id WHERE o.status='sent'",
      )) {
        const outbox = this.outbox.get(row.outbox_id);
        const message = this.store.one<{ external_id: string }>(
          "SELECT external_id FROM messages WHERE id=?",
          outbox.sent_message_id,
        );
        if (message?.external_id !== row.payload.external_id)
          throw new Error("Staged outgoing ID does not match dispatch");
        this.ingest(row.payload);
        this.store.run(
          "DELETE FROM staged_outgoing WHERE outbox_id=?",
          row.outbox_id,
        );
      }
    })();
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
