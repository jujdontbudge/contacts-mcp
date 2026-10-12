import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tools } from "./tools.js";
import type { ContactsCore } from "../core/index.js";
export function createServer(core: ContactsCore): McpServer {
  const server = new McpServer({ name: "contacts-mcp", version: "0.1.0" });
  for (const [name, tool] of Object.entries(tools(core))) {
    // Parse at the boundary so every core call receives its own schema's defaults and validations.
    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.schema },
      async (input: unknown) => {
        try {
          const args = tool.schema.parse(input);
          const invoke = tool.call as (input: unknown) => unknown;
          const result = await invoke(args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }
  return server;
}
