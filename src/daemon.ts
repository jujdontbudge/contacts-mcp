import { createServer as createHTTPServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Channel, ChannelId } from "./channels/channel.js";
import { ChannelRegistry } from "./channels/registry.js";
import { ContactsCore } from "./core/index.js";
import { createServer } from "./mcp/server.js";

export const DEFAULT_SYNC_INTERVALS: Record<ChannelId, number> = {
  imessage: 30_000,
  instagram: 300_000,
  email: 120_000,
  tiktok: 120_000,
};

export async function syncChannel(
  core: ContactsCore,
  channel: Channel,
): Promise<void> {
  let account = channel.accountId ?? "default";
  try {
    const resolved = await channel.resolveAccountId?.() ?? account;
    if (channel.accountId && channel.accountId !== resolved)
      throw new Error("Resolved sync account differs from configured account");
    account = resolved;
  } catch (error) {
    core.recordSync(channel.id, account, null, error instanceof Error ? error.message : String(error));
    throw error;
  }
  channel.accountId = account;
  const owner = core.store.id("sync");
  if (!core.acquireSyncLease(channel.id, account, owner)) return;
  const assertLease = () => {
    if (!core.hasSyncLease(channel.id, account, owner)) throw new Error("Sync lease expired; another process may own this channel/account");
  };
  const heartbeat = setInterval(() => {
    try { core.renewSyncLease(channel.id, account, owner); }
    catch (error) { console.error(`${channel.id} sync lease: ${String(error)}`); }
  }, 15_000);
  heartbeat.unref();
  try {
    core.ensureSyncState(channel.id, account);
    const state = core.syncStatus().find(s => s.channel === channel.id && s.account_id === account);
    let cursor = state?.cursor ?? undefined;
    let maintenanceError: unknown;
    try { await channel.maintenance?.(); }
    catch (error) { maintenanceError = error; }
    for await (const event of channel.sync(cursor, (next) => {
      core.store.db.transaction(() => {
        assertLease();
        // The adapter checkpoints only after the consumer has ingested its page.
        core.checkpointSync(channel.id, account, next);
      }).immediate();
      cursor = next;
    })) {
      if (event.channel !== channel.id || event.account_id !== account)
        throw new Error("Sync event channel/account mismatch");
      core.store.db.transaction(() => {
        assertLease();
        core.ingest(event);
        if (channel.id === "email") {
          cursor = event.external_id;
          core.checkpointSync(channel.id, account, cursor);
        }
      }).immediate();
    }
    if (maintenanceError) throw maintenanceError;
    cursor = channel.getCursor?.() ?? cursor;
    core.store.db.transaction(() => {
      assertLease();
      core.recordSync(channel.id, account, cursor ?? null, null);
    }).immediate();
  } catch (error) {
    core.store.db.transaction(() => {
      if (core.hasSyncLease(channel.id, account, owner)) core.recordSync(channel.id, account, null, error instanceof Error ? error.message : String(error));
    }).immediate();
    throw error;
  } finally {
    clearInterval(heartbeat);
    core.releaseSyncLease(channel.id, account, owner);
  }
}
/** CLI one-shot syncs attempt every enabled channel, then report all failures. */
export async function syncChannels(core: ContactsCore, channels: Channel[]): Promise<void> {
  const results = await Promise.allSettled(channels.map(channel => syncChannel(core, channel)));
  const failures = results.flatMap((result, i) => result.status === "rejected" ? [`${channels[i].id}: ${String(result.reason)}`] : []);
  if (failures.length) throw new Error(failures.join("; "));
}
function syncIntervals(
  registry: ChannelRegistry,
  overrides: Partial<Record<ChannelId, number>>,
) {
  return registry.list().map((channel) => {
    const ms =
      overrides?.[channel.id] ??
      Number(
        process.env[`CONTACTS_SYNC_INTERVAL_${channel.id.toUpperCase()}_MS`] ??
          DEFAULT_SYNC_INTERVALS[channel.id],
      );
    if (!Number.isFinite(ms) || ms < 1)
      throw new Error(`Invalid sync interval for ${channel.id}`);
    return { channel, ms };
  });
}

export function startSyncLoops(
  core: ContactsCore,
  registry: ChannelRegistry,
  overrides: Partial<Record<ChannelId, number>> = {},
) {
  const intervals = syncIntervals(registry, overrides);
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<Promise<void>>();
  const liveStops: (() => void)[] = [];
  for (const { channel, ms } of intervals) {
    core.ensureSyncState(channel.id, channel.accountId);
    const poll = () => {
      if (stopped) return;
      const task = Promise.resolve().then(async () => {
        await syncChannel(core, channel);
      })
        .catch((error) => {
          console.error(`${channel.id} sync: ${String(error)}`);
        })
        .finally(() => {
          pending.delete(task);
          if (!stopped) {
            const timer = setTimeout(() => {
              timers.delete(timer);
              poll();
            }, ms);
            timers.add(timer);
          }
        });
      pending.add(task);
    };
    poll();
    if (channel.live) {
      try {
        liveStops.push(
          channel.live(
            (event) => {
              if (stopped) return;
              try {
                if (event.channel !== channel.id || event.account_id !== (channel.accountId ?? "default"))
                  throw new Error("Live event channel/account mismatch");
                core.ingest(event);
              } catch (error) {
                core.recordSync(
                  channel.id,
                  channel.accountId ?? "default",
                  null,
                  String(error),
                );
              }
            },
            (error) => {
              if (!stopped) core.recordSync(
                channel.id,
                channel.accountId ?? "default",
                null,
                error.message,
              );
            },
          ),
        );
      } catch (error) {
        core.recordSync(
          channel.id,
          channel.accountId ?? "default",
          null,
          String(error),
        );
      }
    }
  }
  return {
    async close() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      for (const stop of liveStops) {
        try { stop(); } catch (error) { console.error(`Live listener shutdown: ${String(error)}`); }
      }
      await Promise.all(pending);
    },
  };
}

export async function startDaemon(
  core: ContactsCore,
  registry: ChannelRegistry,
  options: {
    token?: string;
    host?: string;
    port?: number;
    intervals?: Partial<Record<ChannelId, number>>;
  } = {},
) {
  const token = options.token ?? process.env.CONTACTS_HTTP_TOKEN;
  if (!token?.trim())
    throw new Error("CONTACTS_HTTP_TOKEN is required for serve");
  const host = options.host ?? process.env.CONTACTS_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.CONTACTS_HTTP_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid CONTACTS_HTTP_PORT");
  syncIntervals(registry, options.intervals ?? {}); // Validate before opening the HTTP listener.
  const active = new Set<ReturnType<typeof createServer>>();
  const http = createHTTPServer(async (req, res) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname === "/webhooks/instagram") {
      const instagram = registry.list().find(c => c.id === "instagram") as
        import("./channels/instagram-official.js").InstagramOfficialChannel | undefined;
      if (!instagram?.handleWebhook) { res.writeHead(404); res.end(); return; }
      try {
        await instagram.handleWebhook(req, res, event => { core.ingest(event); });
      } catch {
        core.recordSync("instagram", instagram.accountId!, null, "Instagram webhook ingest failed; awaiting retry");
        if (!res.headersSent) res.writeHead(500);
        if (!res.writableEnded) res.end();
      }
      return;
    }
    const expected = Buffer.from(`Bearer ${token}`),
      actual = Buffer.from(req.headers.authorization ?? "");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.writeHead(401, {
        "WWW-Authenticate": "Bearer",
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    // A separate stateless transport per request supports concurrent agents.
    const server = createServer(core);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    active.add(server);
    res.once("close", () => {
      active.delete(server);
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
      active.delete(server);
      await server.close();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const sync = startSyncLoops(core, registry, options.intervals);
  return {
    address: http.address(),
    async close(): Promise<void> {
      const syncClosed = sync.close();
      const closed = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all([...active].map((server) => server.close()));
      http.closeAllConnections();
      await closed;
      await syncClosed;
    },
  };
}
