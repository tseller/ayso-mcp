import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SportsConnectClient } from "../sportsconnect-client.js";
import { findOrdersByName, findRefunds, getOrder, getOrders, nameMatches } from "../sportsconnect-orders.js";
import {
  allDivisions,
  countByDivision,
  isLive,
  matchingDivisions,
  matchingPrograms,
  readEnrollment,
  roster,
  unpaid,
  type EnrollmentRead,
} from "../sportsconnect-enrollment.js";
import {
  filterVolunteers,
  gaps,
  readVolunteers,
  RISK_STATUS,
  teamStaffing,
  type VolunteerRead,
} from "../sportsconnect-volunteers.js";
import { playerHistory } from "../sportsconnect-history.js";
import { describeEmpty } from "../empty-listing.js";
import { runTool } from "../tool-logging.js";
import { packRows } from "../result-size.js";
import { OFFSET_PAGING_NARROWING } from "./list-paging.js";

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

/** What a volunteer answer read, in words. */
function volunteerSource(read: VolunteerRead): string {
  return (
    `Sports Connect's All Volunteers report sent ${read.rows} row(s)` +
    (read.capped ? ` of ${read.totalRecords} (capped — the list is short)` : "") +
    `, ${read.volunteers.length} volunteer role(s) once de-duplicated (one person holding two roles is two rows). ` +
    "It holds the current membership year only. Coaching licence and referee grade are AYSO's certification as Sports Connect holds it; " +
    "the individual courses behind them (Safe Haven, concussion, cardiac arrest, SafeSport) are not in any report this login can read."
  );
}

/** The offset/limit paging the report tools use (see list-paging.ts). */
const OFFSET_PAGING = {
  offset: z.number().int().min(0).optional().describe("Row offset for paging (default 0). Use `nextOffset` from the previous call."),
  limit: z.number().int().min(1).optional().describe("Max rows in this page. The response is also capped by a size budget, whichever is smaller."),
};
const PAGED = { narrowing: OFFSET_PAGING_NARROWING };

/** One page of rows, in the vocabulary every paged tool here speaks. */
function page<T>(rows: T[], offset: number | undefined, limit: number | undefined, key: string) {
  const p = packRows(rows, offset ?? 0, limit);
  return {
    offset: p.offset,
    returned: p.rows.length,
    hasMore: p.hasMore,
    ...(p.hasMore
      ? {
          nextOffset: p.nextOffset,
          truncatedBy: p.truncatedBy,
          note: `Showing rows ${p.offset}-${p.offset + p.rows.length - 1} of ${rows.length}. Call again with offset: ${p.nextOffset}. The counts above cover every row.`,
        }
      : {}),
    [key]: p.rows,
  };
}

/** A row without its empty fields: a null says nothing a missing key does not. */
function slim<T extends object>(row: T): Partial<T> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined && v !== "")) as Partial<T>;
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

  server.registerTool(
    "sportsconnect_volunteers",
    {
      description:
        "Millbrae AYSO's volunteers this season from Sports Connect — read-only. One row per volunteer role (a parent who coaches and " +
        "referees is two rows): name, email, cell, role (Head Coach, Assistant Coach, Referee, Team Parent, Team Manager, Board Member, …), " +
        "division, team, AYSO risk status (background-check colour), coaching licence and referee grade. Every filter is optional and " +
        'matches every word given, case-insensitively: `role` ("head coach", "referee"), `division` ("10U girls"), `team`, `name`. ' +
        "`byRole` counts the matching roles. For which teams lack a coach or referee use sportsconnect_team_staffing; for who is not " +
        "cleared or certified for their role use sportsconnect_volunteer_gaps. " +
        "Pages with `offset`/`limit` when the list is long; `count` covers every row.",
      inputSchema: z.object({
        role: z.string().min(2).optional().describe('Words from the role, e.g. "head coach", "referee", "team parent".'),
        division: z.string().min(2).optional().describe('Words from the division name, e.g. "10U Girls".'),
        team: z.string().min(2).optional().describe("Words from the team name."),
        name: z.string().min(2).optional().describe("Words from the volunteer's name."),
        ...OFFSET_PAGING,
      }),
    },
    (args) =>
      runTool("sportsconnect_volunteers", args, async ({ offset, limit, ...f }) => {
        const read = await readVolunteers(client);
        const volunteers = filterVolunteers(read.volunteers, f).sort(
          (a, b) =>
            (a.division ?? "").localeCompare(b.division ?? "", "en", { numeric: true }) ||
            (a.team ?? "").localeCompare(b.team ?? "", "en", { numeric: true }) ||
            a.role.localeCompare(b.role) ||
            a.name.localeCompare(b.name),
        );
        const byRole: Record<string, number> = {};
        for (const v of volunteers) byRole[v.role] = (byRole[v.role] ?? 0) + 1;
        return {
          count: volunteers.length,
          byRole,
          source: volunteerSource(read),
          ...(volunteers.length === 0 ? { empty: describeEmpty() } : {}),
          ...page(volunteers.map(({ program: _p, personId: _id, ...v }) => slim(v)), offset, limit, "volunteers"),
        };
      }, PAGED),
  );

  server.registerTool(
    "sportsconnect_team_staffing",
    {
      description:
        "Which Millbrae AYSO teams need a coach or a referee, from Sports Connect — read-only. Every team that has enrolled players, " +
        "with its player count and the volunteers registered to it: head coaches, assistant coaches, referees and other helpers. " +
        "`needs` names what a team is missing (no head coach; no referee registered to this team). `onlyNeeding` (default true) " +
        "returns just the teams missing something; set it false for every team. Optional `division` matches every word given. " +
        "Teams come from where the players are (Enrollment Details), so a team with players and no volunteers at all still appears. " +
        "Pages with `offset`/`limit` when the list is long; `count` covers every row.",
      inputSchema: z.object({
        division: z.string().min(2).optional().describe('Words from the division name, e.g. "12U Boys".'),
        onlyNeeding: z.boolean().optional().describe("Only teams missing a head coach or referee (default true)."),
        ...OFFSET_PAGING,
      }),
    },
    (args) =>
      runTool("sportsconnect_team_staffing", args, async ({ division, onlyNeeding, offset, limit }) => {
        const [enrollment, read] = await Promise.all([readEnrollment(client), readVolunteers(client)]);
        let teams = teamStaffing(enrollment.enrollments.filter(isLive), read.volunteers);
        if (division) teams = teams.filter((t) => nameMatches(division, t.division));
        const all = teams.length;
        if (onlyNeeding !== false) teams = teams.filter((t) => t.needs);
        return {
          teams: all,
          needing: teams.filter((t) => t.needs).length,
          noHeadCoach: teams.filter((t) => t.needs?.includes("no head coach")).length,
          noReferee: teams.filter((t) => t.needs?.some((n) => n.includes("referee"))).length,
          source: `${volunteerSource(read)} Teams and player counts: ${enrollmentSource(enrollment)}`,
          ...(teams.length === 0 ? { empty: describeEmpty() } : {}),
          ...page(teams, offset, limit, "staffing"),
        };
      }, PAGED),
  );

  server.registerTool(
    "sportsconnect_volunteer_gaps",
    {
      description:
        "Millbrae AYSO volunteers who are not yet cleared or certified for the role they hold, from Sports Connect — read-only. " +
        "Checks each role against: AYSO risk status (Green may volunteer anywhere; Blue is a youth volunteer, not a coach; Expired, None, " +
        "Yellow, Orange, Brown and Red are not cleared); a coach's licence against the division's age (a 10U Coach licence does not cover " +
        "a 12U team; no licence on file is a gap); a referee's grade (none on file, or an 8U Official on an older division). " +
        "Each row says every problem in a sentence, with the volunteer's email and cell so they can be reminded. Optional `role` and " +
        "`division` narrow it. Course-by-course completion (Safe Haven, concussion, cardiac arrest, SafeSport) is not in any report " +
        "Sports Connect gives this login, so it is not checked; the licence and grade are what AYSO records when those are done. " +
        "Pages with `offset`/`limit` when the list is long; `count` covers every row.",
      inputSchema: z.object({
        role: z.string().min(2).optional().describe('Words from the role, e.g. "coach", "referee".'),
        division: z.string().min(2).optional().describe('Words from the division name, e.g. "10U".'),
        ...OFFSET_PAGING,
      }),
    },
    (args) =>
      runTool("sportsconnect_volunteer_gaps", args, async ({ role, division, offset, limit }) => {
        const read = await readVolunteers(client);
        const scope = filterVolunteers(read.volunteers, { role, division });
        const found = gaps(scope);
        const byProblem: Record<string, number> = {};
        for (const g of found) {
          for (const p of g.problems) {
            const kind = p.startsWith("risk status")
              ? p.match(/^risk status \w+/)![0]
              : p.includes(" holds ")
                ? "coaching licence below the division's age"
                : p.includes("8U Official")
                  ? "8U Official on an older division"
                  : p;
            byProblem[kind] = (byProblem[kind] ?? 0) + 1;
          }
        }
        const rows = found.map(({ volunteer: { program: _p, personId: _id, ...v }, problems }) => ({ ...slim(v), problems }));
        return {
          checked: scope.length,
          count: found.length,
          byProblem,
          riskStatusKey: Object.fromEntries(Object.entries(RISK_STATUS).map(([k, v]) => [k, v.meaning])),
          source: volunteerSource(read),
          ...(found.length === 0 ? { empty: describeEmpty() } : {}),
          ...page(rows, offset, limit, "gaps"),
        };
      }, PAGED),
  );

  server.registerTool(
    "sportsconnect_unpaid",
    {
      description:
        "Who has not paid for Millbrae AYSO registration this season, from Sports Connect — read-only. Three lists, each with the " +
        "player, division, team, order and the parent's name, email and cell: `owing` (enrolled, with money still owed on the " +
        "registration — `balance`), `pending` (enrolled while payment is still pending) and `declined` (tried to register, every " +
        "attempt in that division was declined, so not enrolled; a family that retried and paid is enrolled and not listed). " +
        "A cancelled registration's leftover balance is not owed and never listed. Optional `division` narrows it. Covers current programs only.",
      inputSchema: z.object({
        division: z.string().min(2).optional().describe('Words from the division name, e.g. "08U Girls".'),
      }),
    },
    (args) =>
      runTool("sportsconnect_unpaid", args, async ({ division }) => {
        const read = await readEnrollment(client);
        const es = division ? read.enrollments.filter((e) => nameMatches(division, e.division)) : read.enrollments;
        const u = unpaid(es);
        const owed = u.owing.reduce((s, r) => s + (r.balance ?? 0), 0);
        return {
          owing: u.owing.length,
          owed: Math.round(owed * 100) / 100,
          pending: u.pending.length,
          declined: u.declined.length,
          source: enrollmentSource(read),
          ...(u.owing.length + u.pending.length + u.declined.length === 0 ? { empty: describeEmpty() } : {}),
          lists: u,
        };
      }),
  );

  server.registerTool(
    "sportsconnect_player_history",
    {
      description:
        "Every season a Millbrae AYSO player registered for, back to the region's first season on Sports Connect (2017) — read-only. " +
        "Give the player's name (first and last, or just the last name). Each matching player comes back with the account " +
        "(parent) and their seasons newest first: program, division, team and status (`enrolled`, `waitlisted`, `cancelled`, `failed` " +
        "for a declined payment) with the order. For the payments and refunds on an order, use sportsconnect_order_lookup. " +
        "It walks every season, so a common surname takes up to a minute; a first and last name narrows it. Pages with `offset`/`limit`.",
      inputSchema: z.object({
        playerName: z.string().min(2).describe("The player's name — first and last, or just the last name."),
        ...OFFSET_PAGING,
      }),
    },
    (args) =>
      runTool("sportsconnect_player_history", args, async ({ playerName, offset, limit }) => {
        const found = await playerHistory(client, playerName);
        return {
          count: found.players.length,
          matching: found.matching,
          ...(found.players.length === 0 ? { empty: describeEmpty() } : {}),
          ...page(found.players, offset, limit, "players"),
        };
      }, PAGED),
  );
}
