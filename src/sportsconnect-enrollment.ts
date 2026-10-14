/**
 * Sports Connect enrollment: who is registered in which program and division.
 *
 * Read from the report wizard's *Enrollment Details* report, the same report
 * the admin site's "Enrollment Details" page runs. Both enrollment tools — the
 * per-division counts and one division's roster — are built from ONE read of
 * it (`readEnrollment`) and ONE rule for what counts as enrolled
 * (`enrollmentState`), so a division's count and its roster cannot disagree.
 *
 * What the report does, probed live on 2026-10-14:
 *
 *  - **A row is a registration line item, not a player.** One player can have
 *    several rows in one division: every declined card attempt is its own
 *    order (`Failed`), and a cancel/transfer leaves the old order `Cancelled`
 *    beside the new one. Counting rows would count those too.
 *  - **The row count depends on the columns asked for.** The report returns
 *    distinct rows over what was selected, so asking for program and division
 *    alone collapses 667 line items to 593. `OrderDetailsOrderDetailId` is
 *    therefore always selected, and de-duplication happens here, on purpose.
 *  - **Enrolled = not Cancelled and not Failed.** Those are exactly the
 *    conditions Sports Connect's own Enrollment Details report ships with
 *    (`StandardReport/…` → `OrdersPaymentStatus NotEqual Cancelled/Failed`).
 *    `Pending` (registered, payment not complete) counts, and is broken out.
 *  - **It leaves out the wait list.** A player waiting for a place has a
 *    `Wait List Registration` line item on a live order and no Enrollment
 *    Details row at all (live: 14U Boys, over its cap, had 8 waiting and none
 *    of them appeared). So the wait list is read from the *Line Item Order*
 *    report, per program, and counted beside enrollment — never in it. A
 *    wait-list order that is `Cancelled` is a player who left the list
 *    (usually by being given a place), so only a live one counts.
 *  - **The Line Item Order report is not an enrollment count either.** A
 *    cancellation creates a new, `Completed` order carrying a `Cancellation`
 *    line item, so counting players with a live line item there counts the
 *    cancelled ones too (582 against Enrollment Details' 555 on the Fall
 *    program; the 27 apart were 18 cancellations and the 9 wait-listed).
 *  - **It covers current programs only.** With no condition at all it returns
 *    just the programs whose divisions have not ended; past seasons are not in
 *    it. The result names the programs it saw rather than implying more.
 *
 * No condition is sent to the Enrollment Details report. The whole answer is a few hundred rows
 * in one page (~7s), and this API answers an operator it does not know with
 * zero rows rather than an error — so filtering by program or division is
 * done here, against every row, and never trusted to the server.
 */

import type { ReportQuery, SportsConnectClient } from "./sportsconnect-client.js";
import { nameMatches, reportDate } from "./sportsconnect-orders.js";

export const ENROLLMENT_DETAILS = {
  reportKey: "ReportWizardEnrollmentDetailsNewRegistration",
  modelId: "ReportWizard_EnrollmentDetails_New_Registration",
} as const;

const LINE_ITEMS = {
  reportKey: "ReportWizardLineItemOrderNewRegistration",
  modelId: "ReportWizard_LineItemOrder_New_Registration",
} as const;

/** The line item a wait-list sign-up is recorded as. */
export const WAIT_LIST_ITEM = "Wait List Registration";

const COLUMNS = [
  "OrderDetailsOrderDetailId",
  "ProgramsProgramId",
  "ProgramsProgramName",
  "DivisionsDivisionId",
  "DivisionsDivisionName",
  "DivisionsMaxPlayers",
  "DivisionsEndDate",
  "OrdersOrderId",
  "OrdersOrderDate",
  "OrdersPaymentStatus",
  "PlayersPlayerId",
  "PlayersFirstName",
  "PlayersLastName",
  "PlayersGender",
  "PlayersDateOfBirth",
  "TeamsTeamName",
  "UsersFirstName",
  "UsersLastName",
  "UsersEmail",
  "UsersCellPhone",
] as const;

type Row = Record<(typeof COLUMNS)[number], string | null> & {
  /** Set on a row read from the wait list rather than from Enrollment Details. */
  waitListed?: true;
};

export type EnrollmentState = "enrolled" | "pending" | "waitlisted" | "cancelled" | "failed";

/** The one rule for what a line item's order status means for enrollment. */
export function enrollmentState(paymentStatus: string | null): EnrollmentState {
  switch ((paymentStatus ?? "").trim().toLowerCase()) {
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      // "Completed", and anything Sports Connect adds later: its own report
      // counts every status except Cancelled and Failed, and so does this.
      return "enrolled";
  }
}

/** Sports Connect's team placeholder for a player not yet on a team. */
const UNALLOCATED = /^unallocated$/i;

export interface Enrollment {
  programId: string;
  program: string;
  divisionId: string;
  division: string;
  /** The division's player cap; 0 means none is set. */
  maxPlayers: number | null;
  endDate: string | null;
  playerId: string;
  player: string;
  gender: string | null;
  birthDate: string | null;
  team: string | null;
  orderId: string;
  orderDate: string | null;
  state: EnrollmentState;
  account: string | null;
  email: string | null;
  phone: string | null;
}

export interface EnrollmentRead {
  /** One per player per division, live registrations preferred over dead ones. */
  enrollments: Enrollment[];
  /** Line items the report sent. */
  lineItems: number;
  /** Line items not counted, by why. */
  notCounted: { cancelled: number; failed: number; duplicate: number };
  capped: boolean;
  totalRecords: number;
  /** How the wait list was read, in words. */
  waitList: string;
}

const blank = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);
const toInt = (s: string | null): number | null => (s && /^\d+$/.test(s.trim()) ? Number(s) : null);
const join = (...parts: Array<string | null>) => parts.filter(Boolean).join(" ") || null;

const RANK: Record<EnrollmentState, number> = { enrolled: 0, pending: 1, waitlisted: 2, cancelled: 3, failed: 4 };

/**
 * Collapse line items to one row per player per division. A player who is
 * live in a division is counted once however many dead orders sit beside the
 * live one; a player with only dead orders there keeps one dead row, so the
 * roster can say "cancelled" rather than forgetting them.
 */
export function collapse(rows: Row[]): Omit<EnrollmentRead, "capped" | "totalRecords" | "waitList"> {
  const notCounted = { cancelled: 0, failed: 0, duplicate: 0 };
  const best = new Map<string, Enrollment>();
  for (const r of rows) {
    const state = r.waitListed ? "waitlisted" : enrollmentState(r.OrdersPaymentStatus);
    if (state === "cancelled" || state === "failed") notCounted[state]++;
    const e: Enrollment = {
      programId: r.ProgramsProgramId ?? "",
      program: r.ProgramsProgramName ?? "",
      divisionId: r.DivisionsDivisionId ?? "",
      division: r.DivisionsDivisionName ?? "",
      maxPlayers: toInt(r.DivisionsMaxPlayers),
      endDate: reportDate(r.DivisionsEndDate),
      playerId: r.PlayersPlayerId ?? "",
      player: join(blank(r.PlayersFirstName), blank(r.PlayersLastName)) ?? "",
      gender: blank(r.PlayersGender),
      birthDate: reportDate(r.PlayersDateOfBirth),
      team: blank(r.TeamsTeamName),
      orderId: r.OrdersOrderId ?? "",
      orderDate: reportDate(r.OrdersOrderDate),
      state,
      account: join(blank(r.UsersFirstName), blank(r.UsersLastName)),
      email: blank(r.UsersEmail),
      phone: blank(r.UsersCellPhone),
    };
    const key = `${e.playerId}|${e.divisionId}`;
    const had = best.get(key);
    if (!had) {
      best.set(key, e);
      continue;
    }
    // Two live rows for one player in one division is a duplicate; a live
    // row beside dead ones is the normal shape and is already counted above.
    const live = (x: Enrollment) => x.state === "enrolled" || x.state === "pending";
    if (live(had) && live(e)) notCounted.duplicate++;
    if (RANK[e.state] < RANK[had.state] || (RANK[e.state] === RANK[had.state] && Number(e.orderId) > Number(had.orderId))) {
      best.set(key, e);
    }
  }
  return { enrollments: [...best.values()], lineItems: rows.filter((r) => !r.waitListed).length, notCounted };
}

const WAIT_LIST_COLUMNS = [
  "OrderDetailsOrderDetailId",
  "ProgramsProgramId",
  "ProgramsProgramName",
  "DivisionsDivisionId",
  "DivisionsDivisionName",
  "OrderDetailsDetail",
  "OrdersOrderId",
  "OrdersOrderDate",
  "OrdersPaymentStatus",
  "PlayersPlayerId",
  "PlayersFirstName",
  "PlayersLastName",
  "UsersFirstName",
  "UsersLastName",
  "UsersEmail",
  "UsersCellPhone",
] as const;

/**
 * Live wait-list line items in the given programs, as rows `collapse` can
 * merge. The report is asked per program — unscoped, the line-item filter
 * walks every season and takes minutes, scoped it is ~2s — and both
 * conditions are re-checked on every row it sends.
 */
export async function readWaitList(
  client: SportsConnectClient,
  programIds: string[],
): Promise<{ rows: Row[]; note: string }> {
  const pages = await Promise.all(
    programIds.map((id) =>
      client.report({
        ...LINE_ITEMS,
        columns: [...WAIT_LIST_COLUMNS],
        conditions: [
          { id: "ProgramsProgramId", operator: "Equal", value: id, dataType: "Int32" },
          { id: "OrderDetailsDetail", operator: "Equal", value: WAIT_LIST_ITEM, dataType: "String" },
        ],
      }).then((page) => ({ id, page })),
    ),
  );
  const rows: Row[] = [];
  let sent = 0;
  let held = 0;
  let capped = false;
  for (const { id, page } of pages) {
    sent += page.rows.length;
    capped ||= page.capped;
    for (const r of page.rows) {
      if (r.ProgramsProgramId !== id || r.OrderDetailsDetail !== WAIT_LIST_ITEM) continue;
      held++;
      const state = enrollmentState(r.OrdersPaymentStatus);
      if (state !== "enrolled" && state !== "pending") continue;
      rows.push({
        ...(r as Record<string, string | null>),
        DivisionsMaxPlayers: null,
        DivisionsEndDate: null,
        PlayersGender: null,
        PlayersDateOfBirth: null,
        TeamsTeamName: null,
        waitListed: true,
      } as Row);
    }
  }
  return {
    rows,
    note:
      `the Line Item Order report sent ${sent} wait-list line item(s) across ${programIds.length} program(s), ` +
      `${held} of them checked as wait-list items in the program asked, ${rows.length} still live` +
      (capped ? " (capped — the wait list is short)" : "") +
      "; a player already enrolled in a division is not counted as waiting for it",
  };
}

export async function readEnrollment(client: SportsConnectClient): Promise<EnrollmentRead> {
  const q: ReportQuery = { ...ENROLLMENT_DETAILS, columns: [...COLUMNS], conditions: [] };
  const page = await client.report(q);
  const programIds = [...new Set(page.rows.map((r) => r.ProgramsProgramId).filter((x): x is string => !!x))];
  const waitList = await readWaitList(client, programIds);
  return {
    ...collapse([...(page.rows as Row[]), ...waitList.rows]),
    capped: page.capped,
    totalRecords: page.totalRecords,
    waitList: waitList.note,
  };
}

export const isLive = (e: Pick<Enrollment, "state">): boolean => e.state === "enrolled" || e.state === "pending";

// ---------------------------------------------------------------------------
// Counts by program and division

export interface DivisionCount {
  divisionId: string;
  division: string;
  /** Live registrations: paid plus pending. */
  enrolled: number;
  /** Of `enrolled`, how many have not finished paying. */
  pending?: number;
  maxPlayers?: number;
  /** Of `enrolled`, how many are not on a team yet. */
  unallocated?: number;
  teams: number;
  /** On the division's wait list and not enrolled in it. Not part of `enrolled`. */
  waitlisted?: number;
  /** Players whose every registration here was cancelled, transferred out or declined — not counted in `enrolled`. */
  notEnrolled?: number;
}

export interface ProgramCount {
  programId: string;
  program: string;
  enrolled: number;
  divisions: DivisionCount[];
}

export function countByDivision(enrollments: Enrollment[]): ProgramCount[] {
  const programs = new Map<string, { program: string; divisions: Map<string, Enrollment[]> }>();
  for (const e of enrollments) {
    const p = programs.get(e.programId) ?? { program: e.program, divisions: new Map() };
    programs.set(e.programId, p);
    p.divisions.set(e.divisionId, [...(p.divisions.get(e.divisionId) ?? []), e]);
  }
  return [...programs.entries()]
    .map(([programId, p]) => {
      const divisions = [...p.divisions.entries()]
        .map(([divisionId, es]): DivisionCount => {
          const live = es.filter(isLive);
          const pending = live.filter((e) => e.state === "pending").length;
          const unallocated = live.filter((e) => !e.team || UNALLOCATED.test(e.team)).length;
          const teams = new Set(live.map((e) => e.team).filter((t): t is string => !!t && !UNALLOCATED.test(t))).size;
          const waitlisted = es.filter((e) => e.state === "waitlisted").length;
          const dead = es.length - live.length - waitlisted;
          const max = es.find((e) => e.maxPlayers != null)?.maxPlayers;
          return {
            divisionId,
            division: es[0].division,
            enrolled: live.length,
            ...(pending ? { pending } : {}),
            ...(max ? { maxPlayers: max } : {}),
            ...(unallocated ? { unallocated } : {}),
            teams,
            ...(waitlisted ? { waitlisted } : {}),
            ...(dead ? { notEnrolled: dead } : {}),
          };
        })
        .sort((a, b) => a.division.localeCompare(b.division, "en", { numeric: true }));
      return { programId, program: p.program, enrolled: divisions.reduce((s, d) => s + d.enrolled, 0), divisions };
    })
    .sort((a, b) => b.enrolled - a.enrolled);
}

// ---------------------------------------------------------------------------
// Choosing a program or a division by name

/** Programs whose name holds every word asked (or whose id is the one asked). */
export function matchingPrograms(enrollments: Enrollment[], program: string): Set<string> {
  return new Set(
    enrollments.filter((e) => e.programId === program.trim() || nameMatches(program, e.program)).map((e) => e.programId),
  );
}

export interface DivisionChoice {
  divisionId: string;
  division: string;
  programId: string;
  program: string;
}

/**
 * The divisions a name (or id) picks out. Matching is on every word, so
 * "10U Girls" picks `10U - Girls` — and "10U" picks both 10U divisions, which
 * the caller is told about rather than handed a merged roster.
 */
export function matchingDivisions(enrollments: Enrollment[], division: string, program?: string): DivisionChoice[] {
  const inProgram = program ? matchingPrograms(enrollments, program) : undefined;
  const out = new Map<string, DivisionChoice>();
  for (const e of enrollments) {
    if (inProgram && !inProgram.has(e.programId)) continue;
    if (e.divisionId !== division.trim() && !nameMatches(division, e.division)) continue;
    out.set(e.divisionId, { divisionId: e.divisionId, division: e.division, programId: e.programId, program: e.program });
  }
  return [...out.values()];
}

/** Every division the report holds, for a caller whose name matched none. */
export function allDivisions(enrollments: Enrollment[]): string[] {
  return [...new Set(enrollments.map((e) => `${e.division} (${e.program})`))].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
}

export interface RosterRow {
  player: string;
  playerId: string;
  gender: string | null;
  birthDate: string | null;
  team: string | null;
  status: EnrollmentState;
  orderId: string;
  orderDate: string | null;
  account: string | null;
  email: string | null;
  phone: string | null;
}

export function roster(
  enrollments: Enrollment[],
  divisionId: string,
  which: (e: Enrollment) => boolean = isLive,
): RosterRow[] {
  return enrollments
    .filter((e) => e.divisionId === divisionId && which(e))
    .map((e) => ({
      player: e.player,
      playerId: e.playerId,
      gender: e.gender,
      birthDate: e.birthDate,
      team: e.team,
      status: e.state,
      orderId: e.orderId,
      orderDate: e.orderDate,
      account: e.account,
      email: e.email,
      phone: e.phone,
    }))
    .sort(
      (a, b) =>
        RANK[a.status] - RANK[b.status] ||
        (a.team ?? "").localeCompare(b.team ?? "", "en", { numeric: true }) ||
        a.player.localeCompare(b.player),
    );
}
