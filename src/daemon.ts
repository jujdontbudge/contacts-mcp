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
  const account = channel.accountId ?? "default";
  core.ensureSyncState(channel.id, account);
  const state = core
    .syncStatus()
    .find((s) => s.channel === channel.id && s.account_id === account) as
    { cursor: string | null } | undefined;
  let cursor = state?.cursor ?? undefined;
  try {
    for await (const event of channel.sync(cursor, (next) => {
      // The adapter checkpoints only after the consumer has ingested its page.
      core.checkpointSync(channel.id, account, next);
      cursor = next;
    })) {
      core.ingest(event);
      if (channel.id === "email") {
        cursor = event.external_id;
        core.checkpointSync(channel.id, account, cursor);
      }
    }
    cursor = channel.getCursor?.() ?? cursor;
    core.recordSync(channel.id, account, cursor ?? null, null);
  } catch (error) {
    core.recordSync(
      channel.id,
      account,
      null,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
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
      const task = syncChannel(core, channel)
        .catch((error) => console.error(`${channel.id} sync: ${String(error)}`))
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
                core.ingest(event);
              } catch (error) {
                core.recordSync(
                  channel.id,
                  event.account_id,
                  null,
                  String(error),
                );
              }
            },
            (error) =>
              core.recordSync(
                channel.id,
                channel.accountId ?? "default",
                null,
                error.message,
              ),
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
      for (const stop of liveStops) stop();
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
