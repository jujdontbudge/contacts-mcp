import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ContactsCore } from "../src/core/index.js";
import {
  ChannelRegistry,
  configuredChannels,
} from "../src/channels/registry.js";
import { FakeChannel } from "../src/channels/fake.js";
import { startDaemon } from "../src/daemon.js";
it("requires a token at startup and rejects unauthenticated HTTP requests", async () => {
  const core = new ContactsCore({ path: ":memory:" });
  const registry = new ChannelRegistry();
  try {
    await expect(startDaemon(core, registry, { token: "" })).rejects.toThrow(
      "required",
    );
    const daemon = await startDaemon(core, registry, {
      token: "offline-secret",
      port: 0,
    });
    const address = daemon.address as { port: number };
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const client = new Client({ name: "http-test", version: "1" });
    try {
      expect((await fetch(url)).status).toBe(401);
      expect(
        (await fetch(url, { headers: { Authorization: "Bearer wrong" } }))
          .status,
      ).toBe(401);
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: "Bearer offline-secret" } },
        }),
      );
      expect((await client.listTools()).tools).toHaveLength(26);
      const result = await client.callTool({
        name: "create_person",
        arguments: { display_name: "HTTP Alice" },
      });
      expect(result.isError).not.toBe(true);
      expect(core.identity.list()[0].display_name).toBe("HTTP Alice");
    } finally {
      await client.close();
      await daemon.close();
    }
  } finally {
    core.close();
  }
});
it("runs poll sync, tracks failures and successes, and stops listeners", async () => {
  const fake = new FakeChannel("email");
  let calls = 0,
    stopped = false;
  fake.sync = async function* () {
    calls++;
    if (calls === 1) throw new Error("offline failure");
  };
  (fake as FakeChannel & { live: () => () => void }).live = () => () => {
    stopped = true;
  };
  const registry = new ChannelRegistry([fake]);
  const core = new ContactsCore({ path: ":memory:", registry });
  const daemon = await startDaemon(core, registry, {
    token: "test",
    port: 0,
    intervals: { email: 10 },
  });
  try {
    await expect
      .poll(() => core.syncStatus()[0]?.last_error)
      .toBe("offline failure");
    await expect.poll(() => core.syncStatus()[0]?.last_ok_at).not.toBeNull();
    expect(core.syncStatus()[0].last_error).toBeNull();
  } finally {
    await daemon.close();
    core.close();
  }
  expect(stopped).toBe(true);
});
it("only enables explicitly configured real channels", async () => {
  expect((await configuredChannels({})).list()).toEqual([]);
  expect(
    (
      await configuredChannels({ CONTACTS_CHANNELS: "imessage, imessage" })
    ).list(),
  ).toHaveLength(1);
  await expect(
    configuredChannels({ CONTACTS_CHANNELS: "fake" }),
  ).rejects.toThrow("Unsupported");
});
