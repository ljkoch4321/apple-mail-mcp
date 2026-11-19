import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

async function connect(run) {
  const server = createServer(run);
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("exposes all tools with annotations", async () => {
  const client = await connect(async () => null);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["create_draft", "forward", "get_message", "list_accounts", "list_mailboxes", "list_messages", "move_messages", "reply", "search_messages", "send_email", "update_messages"]);
  assert.equal(tools.find((t) => t.name === "send_email").annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "list_messages").annotations.readOnlyHint, true);
});

test("routes ops and args to the runner", async () => {
  const calls = [];
  const client = await connect(async (op, args) => (calls.push([op, args]), { ok: 1 }));
  await client.callTool({ name: "create_draft", arguments: { to: ["a@b.com"], subject: "s" } });
  await client.callTool({ name: "send_email", arguments: { to: ["a@b.com"], subject: "s", body: "b" } });
  const r = await client.callTool({ name: "search_messages", arguments: { query: "acme", since_days: 7 } });
  assert.deepEqual(calls[0], ["compose", { to: ["a@b.com"], subject: "s" }]);
  assert.deepEqual(calls[1], ["compose", { to: ["a@b.com"], subject: "s", body: "b", send: true }]);
  assert.deepEqual(calls[2], ["search_messages", { query: "acme", since_days: 7 }]);
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: 1 });
});

test("runner errors become tool errors", async () => {
  const client = await connect(async () => {
    throw new Error("Mail exploded");
  });
  const r = await client.callTool({ name: "list_accounts", arguments: {} });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "Mail exploded");
});

test("rejects invalid input", async () => {
  const client = await connect(async () => null);
  const r = await client.callTool({ name: "send_email", arguments: { to: [], subject: "s", body: "b" } });
  assert.equal(r.isError, true);
});
