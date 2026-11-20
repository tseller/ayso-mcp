import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { QboClient } from "./qbo-client.js";
import { DivvyClient } from "./divvy-client.js";
import { InMemoryOAuthStore } from "./oauth-store.js";
import { AccessStore, narrow } from "./access.js";
import { buildHttpApp } from "./http-server.js";
import { TOOL_ACCESS, registerAllTools, type Access } from "./tool-registry.js";
import type { SportsConnectClient } from "./sportsconnect-client.js";

const TIM = "tim@example.com";
const LAURA = "laura@example.com";
const API_TOKEN = "static-api-token";

/** Every registered tool's name and annotations, for one access level. */
function registered(access: Access) {
  const tools = new Map<string, { annotations?: { readOnlyHint?: boolean } }>();
  const server = {
    registerTool: (name: string, config: { annotations?: { readOnlyHint?: boolean } }) =>
      tools.set(name, config),
  };
  registerAllTools(server as never, access, {
    qbo: Object.create(QboClient.prototype) as QboClient,
    divvy: new DivvyClient("unused"),
    sportsConnect: {} as SportsConnectClient,
    accessStore: new AccessStore(new InMemoryOAuthStore()),
  });
  return tools;
}

test("every registered tool is declared read or write, and nothing declared is missing", () => {
  const all = registered("full");
  for (const name of all.keys()) {
    assert.ok(name in TOOL_ACCESS, `\`${name}\` is registered but not declared read or write in TOOL_ACCESS`);
  }
  for (const name of Object.keys(TOOL_ACCESS)) {
    assert.ok(all.has(name), `TOOL_ACCESS declares \`${name}\`, which no integration registers`);
  }
});

test("a viewer is offered every read tool and no write tool", () => {
  const all = registered("full");
  const viewer = registered("viewer");
  for (const [name, kind] of Object.entries(TOOL_ACCESS)) {
    assert.equal(viewer.has(name), kind === "read", `${name} (${kind})`);
  }
  for (const [name, config] of viewer) {
    assert.equal(config.annotations?.readOnlyHint, true, name);
  }
  // The treasurer keeps everything, and writes are marked as such.
  assert.equal(all.size, Object.keys(TOOL_ACCESS).length);
  assert.equal(all.get("qbo_create_purchase")?.annotations?.readOnlyHint, false);
});

test("the access header narrows and never raises", () => {
  assert.equal(narrow("full", "viewer"), "viewer");
  assert.equal(narrow("full", " Viewer "), "viewer");
  assert.equal(narrow("viewer", "full"), "viewer");
  assert.equal(narrow("full", undefined), "full");
});

// --- The real /mcp app, end to end, with in-memory stores and a recording QBO ---

async function boot() {
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    ALLOWED_EMAILS: TIM,
    MCP_API_TOKEN: API_TOKEN,
  });
  delete process.env.DIVVY_API_TOKEN;
  const store = new InMemoryOAuthStore();
  const calls: Array<{ method: string; path: string }> = [];
  const qbo = Object.create(QboClient.prototype) as QboClient;
  (qbo as unknown as { request: unknown }).request = async (method: string, path: string) => {
    calls.push({ method, path });
    return { Bill: { Id: "1" } };
  };
  const { app, shutdown } = buildHttpApp({
    store,
    qboClient: qbo,
    divvy: undefined,
    sportsConnect: undefined,
    gmail: undefined,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const mint = (token: string, email: string) =>
    store.set("oauth_access_tokens", token, { clientId: "c", googleEmail: email, expiresAt: Date.now() + 3600_000 });
  return {
    url,
    store,
    access: new AccessStore(store),
    calls,
    mint,
    close: async () => {
      await shutdown();
      server.close();
    },
  };
}

async function rpc(
  url: string,
  token: string,
  body: Record<string, unknown>,
  session?: string,
  extra: Record<string, string> = {},
) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" } : {}),
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  const text = await res.text();
  const data = text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "null");
  return { status: res.status, session: res.headers.get("mcp-session-id") ?? undefined, json: JSON.parse(data) };
}

async function open(url: string, token: string, extra: Record<string, string> = {}) {
  const init = await rpc(
    url,
    token,
    {
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    },
    undefined,
    extra,
  );
  assert.equal(init.status, 200, JSON.stringify(init.json));
  const session = init.session!;
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-session-id": session,
      "mcp-protocol-version": "2025-06-18",
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return { session, serverName: init.json.result.serverInfo.name as string };
}

const toolNames = (r: { json: { result?: { tools?: Array<{ name: string }> } } }) =>
  (r.json.result?.tools ?? []).map((t) => t.name);

test("a granted viewer sees only read tools, and a write call is refused by the server", async () => {
  const h = await boot();
  try {
    await h.access.grant(LAURA, "Laura, regional commissioner");
    await h.mint("laura-token", LAURA);
    const { session, serverName } = await open(h.url, "laura-token");
    assert.equal(serverName, "treasurer-mcp-readonly");

    const list = await rpc(h.url, "laura-token", { method: "tools/list" }, session);
    const names = toolNames(list);
    assert.ok(names.includes("qbo_profit_loss") && names.includes("qbo_budget_vs_actuals"), names.join());
    assert.deepEqual(names.filter((n) => TOOL_ACCESS[n] !== "read"), []);

    // Asking for a write anyway: the server has no such tool to run.
    const write = await rpc(
      h.url,
      "laura-token",
      { method: "tools/call", params: { name: "qbo_create_vendor", arguments: { displayName: "X" } } },
      session,
    );
    const refused = JSON.stringify(write.json);
    assert.match(refused, /qbo_create_vendor/);
    assert.ok(write.json.error || write.json.result?.isError, refused);
    assert.deepEqual(h.calls, [], "nothing reached QuickBooks");

    // A read goes through.
    const read = await rpc(h.url, "laura-token", { method: "tools/call", params: { name: "qbo_get_bill", arguments: { id: "1" } } }, session);
    assert.equal(read.json.result?.isError, undefined, JSON.stringify(read.json));
    assert.deepEqual(h.calls, [{ method: "GET", path: "/bill/1" }]);
  } finally {
    await h.close();
  }
});

test("the treasurer keeps every tool, and can preview the viewer's view", async () => {
  const h = await boot();
  try {
    await h.mint("tim-token", TIM);
    for (const token of ["tim-token", API_TOKEN]) {
      const { session, serverName } = await open(h.url, token);
      assert.equal(serverName, "treasurer-mcp");
      const names = toolNames(await rpc(h.url, token, { method: "tools/list" }, session));
      assert.ok(names.includes("qbo_create_purchase") && names.includes("access_revoke_viewer"), token);
    }
    const preview = await open(h.url, API_TOKEN, { "x-treasurer-access": "viewer" });
    assert.equal(preview.serverName, "treasurer-mcp-readonly");
  } finally {
    await h.close();
  }
});

test("revoking a viewer refuses their next request, on the session they already hold", async () => {
  const h = await boot();
  try {
    await h.access.grant(LAURA);
    await h.mint("laura-token", LAURA);
    const { session } = await open(h.url, "laura-token");
    assert.equal((await rpc(h.url, "laura-token", { method: "tools/list" }, session)).status, 200);

    // Tim's one step, through his own connector.
    await h.mint("tim-token", TIM);
    const tim = await open(h.url, "tim-token");
    const revoke = await rpc(
      h.url,
      "tim-token",
      { method: "tools/call", params: { name: "access_revoke_viewer", arguments: { email: LAURA } } },
      tim.session,
    );
    assert.match(revoke.json.result.content[0].text, /"revoked":"laura@example.com"/);

    assert.equal((await rpc(h.url, "laura-token", { method: "tools/list" }, session)).status, 403);
    const again = await rpc(h.url, "laura-token", {
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    assert.equal(again.status, 403);
    // Tim is untouched.
    assert.equal((await rpc(h.url, "tim-token", { method: "tools/list" }, tim.session)).status, 200);
  } finally {
    await h.close();
  }
});

test("a session belongs to whoever opened it", async () => {
  const h = await boot();
  try {
    await h.access.grant(LAURA);
    await h.mint("laura-token", LAURA);
    await h.mint("tim-token", TIM);
    const tim = await open(h.url, "tim-token");
    // Laura holding Tim's session id still cannot use his full server.
    assert.equal((await rpc(h.url, "laura-token", { method: "tools/list" }, tim.session)).status, 403);
  } finally {
    await h.close();
  }
});

test("an email that is neither the treasurer nor granted is refused", async () => {
  const h = await boot();
  try {
    await h.mint("stranger", "someone@example.com");
    const r = await rpc(h.url, "stranger", { method: "tools/list" });
    assert.equal(r.status, 403);
  } finally {
    await h.close();
  }
});

test("on the modern era too, a viewer's write is refused and a read is served", async () => {
  const h = await boot();
  try {
    await h.access.grant(LAURA);
    await h.mint("laura-token", LAURA);
    const v = "2026-07-28";
    const call = (name: string, args: Record<string, unknown>) =>
      rpc(
        h.url,
        "laura-token",
        {
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": v,
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
        undefined,
        { "mcp-protocol-version": v, "mcp-method": "tools/call", "mcp-name": name },
      );
    const write = await call("qbo_create_vendor", { displayName: "X" });
    assert.ok(write.json.error || write.json.result?.isError, JSON.stringify(write.json));
    assert.deepEqual(h.calls, []);
    const read = await call("qbo_get_bill", { id: "1" });
    assert.equal(read.json.result?.isError, undefined, JSON.stringify(read.json));
    assert.deepEqual(h.calls, [{ method: "GET", path: "/bill/1" }]);
  } finally {
    await h.close();
  }
});
