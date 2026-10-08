import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import type { QboConfig, TokenStore } from "./qbo-client.js";
import { InMemoryTokenStore, QboClient } from "./qbo-client.js";
import { SecretManagerTokenStore } from "./secret-manager-store.js";
import { registerQboAccountTools } from "./tools/qbo-accounts.js";
import { registerQboVendorTools } from "./tools/qbo-vendors.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import { registerQboReportTools } from "./tools/qbo-reports.js";
import { registerQboReconcileTools } from "./tools/qbo-reconcile.js";
import { registerQboClassTools } from "./tools/qbo-classes.js";
import { registerQboClassReportTools } from "./tools/qbo-class-reports.js";
import { registerQboClassWriteTools } from "./tools/qbo-class-writes.js";
import { registerQboBudgetTools } from "./tools/qbo-budgets.js";
import { startHttpServer } from "./http-server.js";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";
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

if (!hasQbo && !divvyApiToken) {
  console.error("ERROR: No integrations configured. Set QuickBooks and/or Divvy env vars.");
  process.exit(1);
}

// --- Register tools and start ---

function registerAllTools(server: McpServer) {
  if (qboConfig) {
    const qboClient = new QboClient(qboConfig);
    // stdio runs are single-process and short-lived; in-memory replay
    // protection still covers retries within a session.
    const idempotency = new IdempotencyStore(new InMemoryOAuthStore());
    registerQboAccountTools(server, qboClient);
    registerQboVendorTools(server, qboClient);
    registerQboTransactionTools(server, qboClient, {
      idempotency,
      gmail: gmailClientFromEnv(),
    });
    registerQboReportTools(server, qboClient);
    registerQboReconcileTools(server, qboClient);
    registerQboClassTools(server, qboClient, { idempotency });
    registerQboClassReportTools(server, qboClient);
    registerQboClassWriteTools(server, qboClient);
    registerQboBudgetTools(server, qboClient);
  }

  if (divvyApiToken) {
    const divvyClient = new DivvyClient(divvyApiToken);
    registerDivvyTools(server, divvyClient, { gmail: gmailClientFromEnv() });
  }
}

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
    registerAllTools(server);
    return server;
  });
  console.error("[mcp] Server started (stdio, both MCP eras)");
}
