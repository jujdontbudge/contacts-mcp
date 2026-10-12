import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContactsCore } from "../src/core/index.js";
import { createServer } from "../src/mcp/server.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { FakeChannel } from "../src/channels/fake.js";
it("exposes all 21 tools and runs identity/draft/send/read calls over SDK in-memory transport", async () => {
  const fake = new FakeChannel("email");
  const core = new ContactsCore({
    path: ":memory:",
    registry: new ChannelRegistry([fake]),
  });
  const server = createServer(core);
  const client = new Client({ name: "offline-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const list = await client.listTools();
    expect(list.tools).toHaveLength(21);
    expect(list.tools.map((t) => t.name)).toContain("sync_status");
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0].text);
    }
    const p = await call("create_person", { display_name: "Alice" });
    await call("add_handle", {
      person_id: p.id,
      channel: "email",
      value: "alice@example.com",
      actor: "owner",
      reason: "Confirmed",
    });
    expect((await call("find_person", { query: "Alice" })).person_id).toBe(
      p.id,
    );
    await call("update_person", { person_id: p.id, notes: "Creator" });
    expect((await call("get_person", { person_id: p.id })).notes).toBe(
      "Creator",
    );
    const draft = await call("send_message", {
      person_id: p.id,
      text: "hi",
      created_by: "agent",
    });
    expect(draft.status).toBe("draft");
    expect(await call("list_drafts")).toHaveLength(1);
    const sent = await call("approve_draft", {
      draft_id: draft.id,
      authorized_by: "owner",
      reason: "Approved",
    });
    expect(sent.status).toBe("sent");
    expect(await call("get_timeline", { person_id: p.id })).toHaveLength(1);
    expect(await call("search_messages", { query: "hi" })).toHaveLength(1);
    const conversations = await call("list_conversations", { person_id: p.id });
    expect(conversations).toHaveLength(1);
    expect(
      (await call("get_conversation", { conversation_id: conversations[0].id }))
        .messages,
    ).toHaveLength(1);
    expect(await call("sync_status")).toEqual([]);
    expect(await call("list_link_suggestions")).toEqual([]);
    const bad = await client.callTool({
      name: "send_message",
      arguments: {
        person_id: p.id,
        text: "hi",
        created_by: "agent",
        authorized_by: "owner",
      },
    });
    expect(bad.isError).toBe(true);
    const invalid = await client.callTool({
      name: "get_person",
      arguments: {},
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    core.close();
  }
});
