import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContactsCore } from "../src/core/index.js";
import { createServer } from "../src/mcp/server.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { FakeChannel } from "../src/channels/fake.js";
it("exposes all 26 tools and runs identity/draft/send/read calls over SDK in-memory transport", async () => {
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
    expect(list.tools).toHaveLength(26);
    expect(list.tools.map((t) => t.name)).toContain("sync_status");
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0].text);
    }
    const p = await call("create_person", { display_name: "Alice" });
    const rule = await call("add_send_rule", { scope: "person", value: p.id, channels: ["email"], created_by: "owner" });
    expect(await call("remove_send_rule", { rule_id: rule.id, actor: "owner" })).toMatchObject({ active: 0, removed_by: "owner" });
    expect((await call("list_send_rules"))[0]).toMatchObject({ id: rule.id, active: 0 });
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
    expect(await call("list_inbox")).toEqual({ cutoff: null, items: [] });
    await call("set_inbox_cutoff", { cutoff: "2026-10-12T00:00:00.000Z", actor: "owner" });
    const inbound = core.ingest({ channel: "email", account_id: "default", external_id: "inbox-mcp", conversation_external_id: "inbox-thread", direction: "in", sender: "alice@example.com", text: "Question", sent_at: "2026-10-12T12:00:00.000Z" });
    const inbox = await call("list_inbox");
    expect(inbox.items[0].id).toBe(inbound.id);
    const claim = await call("claim_inbox", { message_ids: [inbound.id], actor: "agent" });
    expect(await call("mark_inbox", { message_id: inbound.id, claim_token: claim.claim_token, outcome: "escalated", actor: "agent", note: "Owner decision needed" })).toMatchObject({ outcome: "escalated" });
    expect((await call("list_inbox")).items).toEqual([]);
  } finally {
    await client.close();
    await server.close();
    core.close();
  }
});
