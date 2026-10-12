#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ContactsCore } from "./core/index.js";
import { createServer } from "./mcp/server.js";
import { configuredChannels } from "./channels/registry.js";
import { startDaemon, syncChannel } from "./daemon.js";
async function main(): Promise<void> {
  const [command, action, ...args] = process.argv.slice(2);
  const registry = await configuredChannels();
  const core = new ContactsCore({ registry });
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
      for (const channel of channels) await syncChannel(core, channel);
      console.log(JSON.stringify(core.syncStatus(), null, 2));
    } finally {
      core.close();
    }
    return;
  }
  if (command === "stdio") {
    const server = createServer(core);
    const close = async () => {
      await server.close();
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
    if (command === "person" && action === "list")
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
        "Usage: contacts-mcp stdio | serve | sync [channel] | person list|show <id>|create <name> | drafts list|approve <id> <authorizer> <reason>|reject <id> <actor> <reason>",
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
