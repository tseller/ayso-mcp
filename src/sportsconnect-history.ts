/**
 * A player's registrations across every season Sports Connect still holds.
 *
 * Enrollment Details holds current programs only, so a question about an old
 * season ("did she play in 2022, and on which team?") is answered from the
 * *Line Item Order* report, which reaches back to the region's first season
 * on Sports Connect (2017 on these books, probed 2026-11-20). The region keeps
 * that access until Sept 2027, after the move to PlayMetrics.
 *
 * A season is read from the line items that ARE a registration — the division
 * price, or a wait-list sign-up — and every other item on the order (fees,
 * discounts, a cancellation line) is left out of the season and only counted.
 * The same status rule as enrollment applies (`enrollmentState`): a
 * cancellation leaves the old order `Cancelled` beside the new one, so a
 * player-season with any live registration line is a season played.
 *
 * The report is asked for a last-name `Contains` (~50s for a common surname,
 * since it walks every season) and every row is re-checked against the whole
 * name here, the same way the order lookup is. The report has no birth-date
 * column, and answers a column it does not have with a bare HTTP 500 rather
 * than naming it — so every column here is one its model lists.
 */

import type { ReportQuery, SportsConnectClient } from "./sportsconnect-client.js";
import { enrollmentState, WAIT_LIST_ITEM, type EnrollmentState } from "./sportsconnect-enrollment.js";
import { nameMatches, reportDate } from "./sportsconnect-orders.js";

const LINE_ITEMS = {
  reportKey: "ReportWizardLineItemOrderNewRegistration",
  modelId: "ReportWizard_LineItemOrder_New_Registration",
} as const;

const COLUMNS = [
  "OrderDetailsOrderDetailId",
  "OrdersOrderId",
  "OrdersOrderDate",
  "OrdersPaymentStatus",
  "OrderDetailsDetail",
  "ProgramsProgramName",
  "DivisionsDivisionName",
  "TeamsTeamName",
  "PlayersPlayerId",
  "PlayersFirstName",
  "PlayersLastName",
  "UsersFirstName",
  "UsersLastName",
] as const;

type Row = Record<(typeof COLUMNS)[number], string | null>;

/** The line item a registration is recorded as. */
const REGISTRATION_ITEM = "Division Price";

export interface Season {
  program: string;
  division: string | null;
  team: string | null;
  status: EnrollmentState;
  orderId: string;
  orderDate: string | null;
}

export interface PlayerHistory {
  player: string;
  playerId: string;
  account: string | null;
  /** Newest first. */
  seasons: Season[];
}

const RANK: Record<EnrollmentState, number> = { enrolled: 0, pending: 1, waitlisted: 2, cancelled: 3, failed: 4 };
const blank = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);

export function histories(rows: Row[]): PlayerHistory[] {
  const players = new Map<string, PlayerHistory & { bySeason: Map<string, Season> }>();
  for (const r of rows) {
    const item = (r.OrderDetailsDetail ?? "").trim();
    const isWait = item === WAIT_LIST_ITEM;
    if (item !== REGISTRATION_ITEM && !isWait) continue;
    const id = r.PlayersPlayerId ?? "";
    let p = players.get(id);
    if (!p) {
      p = {
        player: [blank(r.PlayersFirstName), blank(r.PlayersLastName)].filter(Boolean).join(" "),
        playerId: id,
        account: [blank(r.UsersFirstName), blank(r.UsersLastName)].filter(Boolean).join(" ") || null,
        seasons: [],
        bySeason: new Map(),
      };
      players.set(id, p);
    }
    const base = enrollmentState(r.OrdersPaymentStatus);
    const status: EnrollmentState = isWait && (base === "enrolled" || base === "pending") ? "waitlisted" : base;
    const s: Season = {
      program: blank(r.ProgramsProgramName) ?? "(no program)",
      division: blank(r.DivisionsDivisionName),
      team: blank(r.TeamsTeamName),
      status,
      orderId: r.OrdersOrderId ?? "",
      orderDate: reportDate(r.OrdersOrderDate),
    };
    const key = `${s.program}\u0000${s.division ?? ""}`;
    const had = p.bySeason.get(key);
    if (!had || RANK[s.status] < RANK[had.status] || (RANK[s.status] === RANK[had.status] && Number(s.orderId) > Number(had.orderId))) {
      p.bySeason.set(key, s);
    }
  }
  return [...players.values()].map(({ bySeason, ...p }) => ({
    ...p,
    seasons: [...bySeason.values()].sort(
      (a, b) => (b.orderDate ?? "").localeCompare(a.orderDate ?? "") || Number(b.orderId) - Number(a.orderId),
    ),
  }));
}

export interface HistorySearch {
  players: PlayerHistory[];
  /** How the name was really enforced, in words. */
  matching: string;
}

export async function playerHistory(client: SportsConnectClient, name: string): Promise<HistorySearch> {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("A player name to search for is required");
  const last = words[words.length - 1];
  const q: ReportQuery = {
    ...LINE_ITEMS,
    columns: [...COLUMNS],
    conditions: [{ id: "PlayersLastName", operator: "Contains", value: last, dataType: "String" }],
  };
  const page = await client.report(q);
  const held = (page.rows as Row[]).filter((r) => nameMatches(name, `${r.PlayersFirstName ?? ""} ${r.PlayersLastName ?? ""}`));
  const players = histories(held).sort((a, b) => a.player.localeCompare(b.player));
  return {
    players,
    matching:
      `the Line Item Order report (every season since the region joined Sports Connect) was asked for a player last name containing "${last}" ` +
      `and sent ${page.rows.length} line item(s); ${held.length} matched every word of "${name}" here` +
      (page.capped ? `; the report held ${page.totalRecords} rows and only ${page.rows.length} were read, so older seasons may be missing` : "") +
      ". A season is the division registration (or wait-list sign-up) line; fees, discounts and cancellation lines are not seasons.",
  };
}
