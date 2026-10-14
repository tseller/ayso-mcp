import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SportsConnectClient } from "../sportsconnect-client.js";
import { findOrdersByName, findRefunds, getOrder, getOrders } from "../sportsconnect-orders.js";
import { describeEmpty } from "../empty-listing.js";
import { runTool } from "../tool-logging.js";

/** Orders one name lookup will read in full. */
const MAX_LOOKUP_ORDERS = 15;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

export function registerSportsConnectTools(server: McpServer, client: SportsConnectClient): void {
  server.registerTool(
    "sportsconnect_order_lookup",
    {
      description:
        "Look up Millbrae AYSO registration orders in Sports Connect (Stack Sports / Blue Sombrero) — read-only. " +
        "Give exactly one of `orderId`, `playerName` or `accountName` (the parent who placed the order). " +
        "Each order comes back with its status, amounts, open balance, the players and line items on it, and its full payment history: " +
        "every payment and every refund (`kind: \"refund\"`, a negative `amount`, and `refundOf` naming the payment it returned). " +
        "`refunded` is the order's refund total. A cancelled registration's refund appears on the order the cancellation created, " +
        "which keeps the original order date — `previousOrderId` links it back. " +
        "Names match on every word given, case-insensitively, and `matching` says how many report rows were checked.",
      inputSchema: z.object({
        orderId: z.string().regex(/^\d+$/).optional().describe("A Sports Connect order number (digits only)."),
        playerName: z.string().min(2).optional().describe('The player\'s name — first and last, or just the last name.'),
        accountName: z.string().min(2).optional().describe("The account holder (parent) who placed the order."),
      }),
    },
    (args) =>
      runTool("sportsconnect_order_lookup", args, async ({ orderId, playerName, accountName }) => {
        const given = [orderId, playerName, accountName].filter(Boolean).length;
        if (given !== 1) throw new Error("Give exactly one of orderId, playerName or accountName");
        if (orderId) return { orders: [await getOrder(client, orderId)] };

        const name = (playerName ?? accountName)!;
        const search = await findOrdersByName(client, name, playerName ? "player" : "account");
        const ids = search.orderIds.slice(0, MAX_LOOKUP_ORDERS);
        const { orders, failed } = await getOrders(client, ids);
        return {
          returned: orders.length,
          ...(search.orderIds.length > ids.length
            ? {
                hasMore: true,
                note: `${search.orderIds.length} orders match; the newest ${ids.length} are read here. Use a fuller name, or orderId for one of the rest: ${search.orderIds.slice(ids.length).join(", ")}`,
              }
            : {}),
          matching: search.matching,
          ...(failed.length ? { failed } : {}),
          ...(orders.length === 0 && failed.length === 0 ? { empty: describeEmpty() } : {}),
          orders,
        };
      }),
  );

  server.registerTool(
    "sportsconnect_refunds_since",
    {
      description:
        "List every refund Sports Connect issued on or after `since` (and on or before `until`, if given) for Millbrae AYSO — read-only. " +
        "Each row is one refund back to a family's card: date, amount, order, account, players, card, and the original payment it returned. " +
        "`total` sums them. Sports Connect offers no refund ledger this login can read, so refunds are found by reading every order " +
        "that a cancellation/transfer or a line-item change touched since `since` — `candidates` says how many each source named and " +
        "`ordersChecked` how many were read. A refund made with no change to its order would not be seen; `failed` lists any order that could not be read. " +
        "Takes about 1s per 5 orders read — roughly a minute for three months.",
      inputSchema: z.object({
        since: isoDate.describe("Earliest refund date, YYYY-MM-DD."),
        until: isoDate.optional().describe("Latest refund date, YYYY-MM-DD, inclusive."),
      }),
    },
    (args) =>
      runTool("sportsconnect_refunds_since", args, async ({ since, until }) => {
        const found = await findRefunds(client, since, until);
        return {
          since,
          ...(until ? { until } : {}),
          returned: found.refunds.length,
          total: found.total,
          ordersChecked: found.ordersChecked,
          candidates: found.candidates,
          ...(found.failed.length ? { failed: found.failed } : {}),
          ...(found.refunds.length === 0
            ? {
                empty: describeEmpty(),
              }
            : {}),
          refunds: found.refunds,
        };
      }),
  );
}
