import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SportsConnectClient } from "../sportsconnect-client.js";
import { findOrdersByName, findRefunds, getOrder, getOrders } from "../sportsconnect-orders.js";
import {
  allDivisions,
  countByDivision,
  isLive,
  matchingDivisions,
  matchingPrograms,
  readEnrollment,
  roster,
  type EnrollmentRead,
} from "../sportsconnect-enrollment.js";
import { describeEmpty } from "../empty-listing.js";
import { runTool } from "../tool-logging.js";

/** Orders one name lookup will read in full. */
const MAX_LOOKUP_ORDERS = 15;

/** What an enrollment answer read, stated the same way by both enrollment tools. */
function enrollmentSource(read: EnrollmentRead): string {
  const { cancelled, failed, duplicate } = read.notCounted;
  return (
    `Sports Connect's Enrollment Details report sent ${read.lineItems} registration line item(s)` +
    (read.capped ? ` of ${read.totalRecords} (capped — counts are short)` : "") +
    `; one player in one division counts once. Not counted: ${cancelled} cancelled or transferred-out line item(s), ` +
    `${failed} declined-payment attempt(s)` +
    (duplicate ? `, ${duplicate} second live registration(s) of a player already counted` : "") +
    `. The report holds current programs only (divisions not yet ended), not past seasons. Wait list: ${read.waitList}.`
  );
}

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

  server.registerTool(
    "sportsconnect_enrollment_counts",
    {
      description:
        "Enrollment counts for Millbrae AYSO from Sports Connect, by program and division — read-only. " +
        "Each division states `enrolled` (players registered and not cancelled — Sports Connect's own Enrollment Details rule), " +
        "`pending` (of those, payment not complete), `maxPlayers` (the division's cap, when one is set), `teams` and `unallocated` " +
        "(enrolled players not yet on a team), `waitlisted` (on the division's wait list — not part of `enrolled`), " +
        "and `notEnrolled` (players whose every registration there was cancelled, transferred out or declined). " +
        "A player counts once per division however many orders they have. Covers the current programs Sports Connect holds open, not past seasons. " +
        "Optional `program` narrows to programs whose name holds every word given (or a program id). " +
        "For the players in one division, use sportsconnect_division_roster.",
      inputSchema: z.object({
        program: z.string().min(2).optional().describe('Words from the program name, e.g. "Fall Core", or a program id.'),
      }),
    },
    (args) =>
      runTool("sportsconnect_enrollment_counts", args, async ({ program }) => {
        const read = await readEnrollment(client);
        let es = read.enrollments;
        if (program) {
          const ids = matchingPrograms(es, program);
          if (ids.size === 0) {
            const names = [...new Set(es.map((e) => `${e.program} (${e.programId})`))];
            throw new Error(`No current program matches "${program}". Programs Sports Connect holds: ${names.join("; ")}`);
          }
          es = es.filter((e) => ids.has(e.programId));
        }
        const programs = countByDivision(es);
        const live = es.filter(isLive);
        return {
          enrolled: live.length,
          players: new Set(live.map((e) => e.playerId)).size,
          waitlisted: es.filter((e) => e.state === "waitlisted").length,
          programs,
          source: enrollmentSource(read),
          ...(programs.length === 0 ? { empty: describeEmpty() } : {}),
        };
      }),
  );

  server.registerTool(
    "sportsconnect_division_roster",
    {
      description:
        "The players enrolled in one Millbrae AYSO division, from Sports Connect — read-only. " +
        '`division` matches every word given against the division name ("10U Girls" → "10U - Girls"), or takes a division id; ' +
        "add `program` when the same division name exists in more than one program. A name matching several divisions is an error " +
        "listing them, never a merged roster. Each player comes with team (\"Unallocated\" until placed), status (`enrolled`/`pending`), " +
        "birth date, gender, the order, and the parent account's name, email and cell phone. " +
        "The roster is the same set `sportsconnect_enrollment_counts` counts. Players on the division's wait list come back separately " +
        "under `waitList` (name, order, parent contact; Sports Connect's wait list carries no team or birth date). " +
        "`includeCancelled` adds the players whose registration there was cancelled, transferred out or declined, marked by status.",
      inputSchema: z.object({
        division: z.string().min(2).describe('Words from the division name, e.g. "10U Girls", or a division id.'),
        program: z.string().min(2).optional().describe("Words from the program name, or a program id, when the division name is ambiguous."),
        includeCancelled: z.boolean().optional().describe("Also list players whose registration in this division is no longer live."),
      }),
    },
    (args) =>
      runTool("sportsconnect_division_roster", args, async ({ division, program, includeCancelled }) => {
        const read = await readEnrollment(client);
        const found = matchingDivisions(read.enrollments, division, program);
        if (found.length === 0) {
          throw new Error(
            `No current division matches "${division}"${program ? ` in a program matching "${program}"` : ""}. ` +
              `Divisions Sports Connect holds: ${allDivisions(read.enrollments).join("; ")}`,
          );
        }
        if (found.length > 1) {
          throw new Error(
            `"${division}" matches ${found.length} divisions — name one (or pass its id as \`division\`, or add \`program\`): ` +
              found.map((d) => `${d.division} [${d.divisionId}] in ${d.program}`).join("; "),
          );
        }
        const d = found[0];
        const players = roster(read.enrollments, d.divisionId, (e) =>
          isLive(e) || (!!includeCancelled && (e.state === "cancelled" || e.state === "failed")),
        );
        const waitList = roster(read.enrollments, d.divisionId, (e) => e.state === "waitlisted");
        const { division: _name, divisionId: _id, ...count } = countByDivision(read.enrollments.filter((e) => e.divisionId === d.divisionId))[0].divisions[0];
        return {
          division: d.division,
          divisionId: d.divisionId,
          program: d.program,
          programId: d.programId,
          ...count,
          returned: players.length,
          source: enrollmentSource(read),
          ...(players.length === 0 ? { empty: describeEmpty() } : {}),
          players,
          ...(waitList.length ? { waitList } : {}),
        };
      }),
  );
}
