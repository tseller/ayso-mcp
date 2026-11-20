import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import type { QboConfig, TokenStore } from "./qbo-client.js";
import { InMemoryTokenStore, QboClient } from "./qbo-client.js";
import { SecretManagerTokenStore } from "./secret-manager-store.js";
import { startHttpServer } from "./http-server.js";
import { DivvyClient } from "./divvy-client.js";
import { sportsConnectClientFromEnv } from "./sportsconnect-client.js";
import { registerAllTools } from "./tool-registry.js";
import { IdempotencyStore } from "./idempotency.js";
import { InMemoryOAuthStore } from "./oauth-store.js";
import { gmailClientFromEnv } from "./gmail-client.js";

// --- QuickBooks config (optional) ---

const isHttp = process.env.MCP_TRANSPORT === "http";
const hasQboBase = !!(
  process.env.INTUIT_CLIENT_ID &&
  process.env.INTUIT_CLIENT_SECRET &&
  process.env.QBO_REALM_ID
);
// stdio bootstraps from an env-var refresh token; HTTP reads from Secret Manager.
const hasQbo = hasQboBase && (isHttp || !!process.env.QBO_REFRESH_TOKEN);

let qboConfig: QboConfig | undefined;
if (hasQbo) {
  let tokenStore: TokenStore;
  if (isHttp) {
    const projectId = process.env.GCP_PROJECT_ID || "mcp-servers-487419";
    const secretId = process.env.QBO_REFRESH_TOKEN_SECRET || "QBO_REFRESH_TOKEN";
    tokenStore = new SecretManagerTokenStore(projectId, secretId);
  } else {
    tokenStore = new InMemoryTokenStore(process.env.QBO_REFRESH_TOKEN!);
  }

  qboConfig = {
    clientId: process.env.INTUIT_CLIENT_ID!,
    clientSecret: process.env.INTUIT_CLIENT_SECRET!,
    realmId: process.env.QBO_REALM_ID!,
    tokenStore,
    baseUrl: process.env.QBO_BASE_URL,
  };
  console.error("[mcp] QuickBooks tools enabled");
} else {
  console.error("[mcp] QuickBooks tools disabled (missing env vars)");
}

// --- Divvy config (optional) ---

const divvyApiToken = process.env.DIVVY_API_TOKEN;
if (divvyApiToken) {
  console.error("[mcp] Divvy tools enabled");
} else {
  console.error("[mcp] Divvy tools disabled (missing DIVVY_API_TOKEN)");
}

// --- Sports Connect config (optional) ---

const sportsConnect = sportsConnectClientFromEnv();
console.error(
  sportsConnect
    ? "[mcp] Sports Connect tools enabled"
    : "[mcp] Sports Connect tools disabled (missing SPORTSCONNECT_USERNAME/SPORTSCONNECT_PASSWORD)",
);

if (!hasQbo && !divvyApiToken && !sportsConnect) {
  console.error("ERROR: No integrations configured. Set QuickBooks and/or Divvy env vars.");
  process.exit(1);
}

// --- Register tools and start ---

// stdio runs are single-process and short-lived; in-memory replay protection
// still covers retries within a session. The local process is the treasurer.
const stdioDeps = {
  qbo: qboConfig ? new QboClient(qboConfig) : undefined,
  divvy: divvyApiToken ? new DivvyClient(divvyApiToken) : undefined,
  sportsConnect,
  idempotency: new IdempotencyStore(new InMemoryOAuthStore()),
  gmail: gmailClientFromEnv(),
};

if (process.env.MCP_TRANSPORT === "http") {
  startHttpServer(qboConfig);
} else {
  // `serveStdio` owns the era decision for the connection: the opening
  // exchange selects it and one instance from this factory is pinned for the
  // connection's lifetime. Both eras are served (the default posture), so a
  // 2026 client's `server/discover` opening works over stdio for the same
  // reason it works over HTTP — rather than the modern era being a property of
  // one transport. A hand-connected `StdioServerTransport` would serve the
  // 2025 era only, whatever SDK it is compiled against.
  serveStdio(() => {
    const server = new McpServer(
      { name: "treasurer-mcp", version: "0.2.0" },
      { capabilities: { tools: {} } },
    );
    registerAllTools(server, "full", stdioDeps);
    return server;
  });
  console.error("[mcp] Server started (stdio, both MCP eras)");
}
