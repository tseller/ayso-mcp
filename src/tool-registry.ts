/**
 * The one list of tools this server offers, and who may be offered which.
 *
 * Both transports (HTTP's two protocol eras and stdio) build a server through
 * `registerAllTools`, so a tool registered here is reachable from every way in
 * — and, because registration goes through `scopeServer`, it is reachable
 * only by callers whose access covers it.
 *
 * Access is a property of the CALLER, decided per request in `src/access.ts`:
 *
 *  - `full`   — the treasurer: every tool.
 *  - `viewer` — someone who may see the books and change nothing (#78): only
 *               tools declared `read` below are registered on their server.
 *
 * A tool a viewer's server does not register cannot be called on it: the SDK
 * answers `tools/call` for an unknown name with an error before any handler
 * runs. So a write is refused by the server, not merely left out of a list.
 *
 * Every tool must be declared in `TOOL_ACCESS`. One that is not is treated as
 * a write (it never reaches a viewer), and `tool-access.test.ts` fails the
 * suite by name until someone says which it is — the same pin
 * `DIVVY_LIST_TOOLS` puts on paging.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { QboClient } from "./qbo-client.js";
import type { DivvyClient } from "./divvy-client.js";
import type { SportsConnectClient } from "./sportsconnect-client.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { GmailClient } from "./gmail-client.js";
import type { AccessStore } from "./access.js";
import { registerQboAccountTools } from "./tools/qbo-accounts.js";
import { registerQboVendorTools } from "./tools/qbo-vendors.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import { registerQboReportTools } from "./tools/qbo-reports.js";
import { registerQboReconcileTools } from "./tools/qbo-reconcile.js";
import { registerQboClassTools } from "./tools/qbo-classes.js";
import { registerQboClassReportTools } from "./tools/qbo-class-reports.js";
import { registerQboClassWriteTools } from "./tools/qbo-class-writes.js";
import { registerQboBudgetTools } from "./tools/qbo-budgets.js";
import { registerDivvyTools } from "./tools/divvy.js";
import { registerSportsConnectTools } from "./tools/sportsconnect.js";
import { registerAccessTools } from "./tools/access.js";
import { QBO_RECORDS } from "./qbo-records.js";

export type Access = "full" | "viewer";

/** `read` never changes anything anywhere; `write` can (or administers who can). */
export type ToolKind = "read" | "write";

/**
 * Every tool, by what it can do. A tool that can change QuickBooks, Divvy or
 * Sports Connect — including a dry-run-capable write, whose same call without
 * `dryRun` writes — is `write`. So is anything that administers access.
 */
export const TOOL_ACCESS: Record<string, ToolKind> = {
  // QuickBooks — reads
  qbo_list_accounts: "read",
  qbo_account_balances: "read",
  qbo_list_vendors: "read",
  qbo_search_vendors: "read",
  ...Object.fromEntries(Object.values(QBO_RECORDS).map((r) => [r.tool, "read" as const])),
  qbo_list_purchases: "read",
  qbo_list_deposits: "read",
  qbo_list_transfers: "read",
  qbo_list_attachments: "read",
  qbo_get_attachment_preview: "read",
  qbo_transaction_report: "read",
  qbo_profit_loss: "read",
  qbo_balance_sheet: "read",
  qbo_reconcile_worksheet: "read",
  qbo_cleared_transactions: "read",
  qbo_list_classes: "read",
  qbo_class_transactions: "read",
  qbo_profit_loss_by_class: "read",
  qbo_list_budgets: "read",
  qbo_budget_vs_actuals: "read",

  // QuickBooks — writes
  qbo_create_vendor: "write",
  qbo_update_purchase: "write",
  qbo_create_purchase: "write",
  qbo_create_deposit: "write",
  qbo_create_deposits_batch: "write",
  qbo_update_deposit: "write",
  qbo_create_transfer: "write",
  qbo_create_journal_entry: "write",
  qbo_attach_file: "write",
  qbo_create_class: "write",
  qbo_update_class: "write",
  qbo_set_transaction_class: "write",
  qbo_set_transaction_class_batch: "write",

  // Divvy / BILL Spend & Expense — reads
  divvy_list_transactions: "read",
  divvy_get_transaction: "read",
  divvy_list_cards: "read",
  divvy_list_custom_fields: "read",
  divvy_list_custom_field_values: "read",
  divvy_list_members: "read",
  divvy_list_budgets: "read",
  divvy_list_pending_action: "read",

  // Divvy — writes
  divvy_upload_receipt: "write",
  divvy_update_transaction_custom_fields: "write",

  // Sports Connect — read-only by construction (READ_ENDPOINTS)
  sportsconnect_order_lookup: "read",
  sportsconnect_refunds_since: "read",
  sportsconnect_enrollment_counts: "read",
  sportsconnect_division_roster: "read",

  // Who may see the books — the treasurer's alone
  access_list_viewers: "write",
  access_grant_viewer: "write",
  access_revoke_viewer: "write",
};

/** Whether a caller with `access` is offered a tool. Undeclared tools are writes. */
export function offers(access: Access, tool: string): boolean {
  return access === "full" || TOOL_ACCESS[tool] === "read";
}

/**
 * A view of `server` whose `registerTool` registers only what `access` covers,
 * and marks each tool it does register with MCP's own `readOnlyHint`, so a
 * client can show the difference too.
 */
export function scopeServer(server: McpServer, access: Access): McpServer {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: Record<string, unknown>,
    cb: unknown,
  ) => unknown;
  const scoped = (name: string, config: Record<string, unknown>, cb: unknown) => {
    if (!(name in TOOL_ACCESS)) {
      console.error(`[access] tool ${name} is not declared in TOOL_ACCESS; treated as a write`);
    }
    if (!offers(access, name)) return undefined;
    const readOnly = TOOL_ACCESS[name] === "read";
    const annotations = { ...(config.annotations as object | undefined), readOnlyHint: readOnly };
    return register(name, { ...config, annotations }, cb);
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") return scoped;
      return Reflect.get(target, prop, receiver);
    },
  });
}

export interface ToolDeps {
  qbo?: QboClient;
  divvy?: DivvyClient;
  sportsConnect?: SportsConnectClient;
  idempotency?: IdempotencyStore;
  gmail?: GmailClient;
  /** Where viewer grants live. Absent (stdio) means no access tools. */
  accessStore?: AccessStore;
}

/** Register every tool `access` covers on `server`. */
export function registerAllTools(server: McpServer, access: Access, deps: ToolDeps): void {
  const s = scopeServer(server, access);
  const { qbo, divvy, sportsConnect, idempotency, gmail, accessStore } = deps;

  if (qbo) {
    registerQboAccountTools(s, qbo);
    registerQboVendorTools(s, qbo);
    registerQboTransactionTools(s, qbo, { idempotency, gmail });
    registerQboReportTools(s, qbo);
    registerQboReconcileTools(s, qbo);
    registerQboClassTools(s, qbo, { idempotency });
    registerQboClassReportTools(s, qbo);
    registerQboClassWriteTools(s, qbo);
    registerQboBudgetTools(s, qbo);
  }
  if (divvy) registerDivvyTools(s, divvy, { gmail });
  if (sportsConnect) registerSportsConnectTools(s, sportsConnect);
  if (accessStore) registerAccessTools(s, accessStore);
}
