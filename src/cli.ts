#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import type { EmailChannel } from "./channels/email.js";
import { createContactsSystem } from "./composition.js";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { createServer } from "./mcp/server.js";
import { startDaemon, startSyncLoops, syncChannels } from "./daemon.js";
async function main(): Promise<void> {
  const [command, action, ...args] = process.argv.slice(2);
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envPath)) loadEnvFile(envPath);
  const { core, registry } = await createContactsSystem({
    path:
      process.env.CONTACTS_DB ??
      fileURLToPath(new URL("../data/contacts.db", import.meta.url)),
  });
  if (command === "serve") {
    try {
      const daemon = await startDaemon(core, registry);
      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await daemon.close();
        core.close();
      };
      process.once("SIGINT", () => {
        void close();
      });
      process.once("SIGTERM", () => {
        void close();
      });
      console.error(
        `contacts-mcp HTTP listening: ${JSON.stringify(daemon.address)} /mcp`,
      );
    } catch (error) {
      core.close();
      throw error;
    }
    return;
  }
  if (command === "sync") {
    try {
      const channels = action
        ? [registry.get(action as Parameters<typeof registry.get>[0])]
        : registry.list();
      if (!channels.length)
        throw new Error("No channels enabled; set CONTACTS_CHANNELS");
      await syncChannels(core, channels);
      console.log(JSON.stringify(core.syncStatus(), null, 2));
    } finally {
      core.close();
    }
    return;
  }
  if (command === "stdio") {
    const server = createServer(core);
    const sync = startSyncLoops(core, registry);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await server.close();
      await sync.close();
      core.close();
    };
    process.once("SIGINT", () => {
      void close();
    });
    process.once("SIGTERM", () => {
      void close();
    });
    process.stdin.once("end", () => {
      void close();
    });
    await server.connect(new StdioServerTransport());
    return;
  }
  try {
    let result: unknown;
    if (command === "inbox" && action === "cutoff" && args[0] && args[1])
      result = core.inbox.setCutoff(args[0] === "now" ? new Date().toISOString() : args[0], args[1]);
    else if (command === "repair-email-threads") {
      const email = registry.list().find((c) => c.id === "email") as
        EmailChannel | undefined;
      if (email) await email.refreshSent();
      result = core.conversations.repairEmailThreads();
    } else if (command === "person" && action === "list")
      result = core.identity.list();
    else if (command === "person" && action === "show" && args[0])
      result = core.identity.detail(args[0]);
    else if (command === "person" && action === "create" && args[0])
      result = core.identity.create({ display_name: args.join(" ") });
    else if (command === "drafts" && action === "list")
      result = core.outbox.list();
    else if (
      command === "drafts" &&
      action === "approve" &&
      args[0] &&
      args[1] &&
      args[2]
    )
      result = await core.outbox.approve(
        args[0],
        args[1],
        args.slice(2).join(" "),
      );
    else if (
      command === "drafts" &&
      action === "reject" &&
      args[0] &&
      args[1] &&
      args[2]
    )
      result = core.outbox.reject(args[0], args[1], args.slice(2).join(" "));
    else
      throw new Error(
        "Usage: contacts-mcp stdio | serve | sync [channel] | inbox cutoff <ISO|now> <actor> | repair-email-threads | person list|show <id>|create <name> | drafts list|approve <id> <authorizer> <reason>|reject <id> <actor> <reason>",
      );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    core.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
