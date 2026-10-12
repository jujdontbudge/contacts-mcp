#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ContactsCore } from "./core/index.js";
import { createServer } from "./mcp/server.js";
async function main(): Promise<void> {
  const [command, action, ...args] = process.argv.slice(2);
  if (command === "serve" || command === "sync") {
    console.log("phase 3");
    return;
  }
  const core = new ContactsCore();
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
