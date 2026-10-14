import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReportQuery, SportsConnectClient } from "./sportsconnect-client.js";
import {
  ENROLLMENT_DETAILS,
  WAIT_LIST_ITEM,
  countByDivision,
  enrollmentState,
  matchingDivisions,
  readEnrollment,
  roster,
} from "./sportsconnect-enrollment.js";

// Line items shaped like the Enrollment Details report's rows. Names, ids and
// contact details are invented — this repository is public.
const FALL = { ProgramsProgramId: "1", ProgramsProgramName: "MY 2026 Fall CORE Soccer" };
const G10 = { ...FALL, DivisionsDivisionId: "10", DivisionsDivisionName: "10U - Girls", DivisionsMaxPlayers: "34" };
const B10 = { ...FALL, DivisionsDivisionId: "11", DivisionsDivisionName: "10U - Boys", DivisionsMaxPlayers: "0" };

let detail = 0;
const item = (div: object, player: string, status: string, orderId: string, team = "Unallocated") => ({
  OrderDetailsOrderDetailId: String(++detail),
  ...div,
  DivisionsEndDate: "11/7/2026 12:00:00 AM",
  OrdersOrderId: orderId,
  OrdersOrderDate: "6/1/2026 3:19:54 AM",
  OrdersPaymentStatus: status,
  PlayersPlayerId: player,
  PlayersFirstName: `Kid${player}`,
  PlayersLastName: "Example",
  PlayersGender: "Female",
  PlayersDateOfBirth: "12/31/2016 12:00:00 AM",
  TeamsTeamName: team,
  UsersFirstName: "Pat",
  UsersLastName: "Example",
  UsersEmail: "pat@example.com",
  UsersCellPhone: "555-0100",
});

const ROWS = [
  // Two declined card attempts, then a paid order: one enrollment.
  item(G10, "p1", "Failed", "100"),
  item(G10, "p1", "Failed", "101"),
  item(G10, "p1", "Completed", "102", "10UG-01 Smith"),
  // Transferred: the old order cancelled, the replacement live.
  item(G10, "p2", "Cancelled", "200"),
  item(G10, "p2", "Completed", "201", "10UG-02 Jones"),
  // Registered, not yet paid: enrolled, and said to be pending.
  item(G10, "p3", "Pending", "300"),
  // Cancelled and never re-made: not enrolled.
  item(G10, "p4", "Cancelled", "400"),
  item(B10, "p5", "Completed", "500"),
];

// Wait-list line items, as the Line Item Order report sends them.
const waiting = (div: object, player: string, status: string, orderId: string) => ({
  OrderDetailsOrderDetailId: String(++detail),
  ...div,
  OrderDetailsDetail: WAIT_LIST_ITEM,
  OrdersOrderId: orderId,
  OrdersOrderDate: "9/2/2026 3:51:46 PM",
  OrdersPaymentStatus: status,
  PlayersPlayerId: player,
  PlayersFirstName: `Kid${player}`,
  PlayersLastName: "Waiting",
});

function fakeClient(rows: object[], waitList: object[] = []) {
  const asked: ReportQuery[] = [];
  const client = {
    report: async (q: ReportQuery) => {
      asked.push(q);
      const r = q.reportKey === ENROLLMENT_DETAILS.reportKey ? rows : waitList;
      return { totalRecords: r.length, columns: q.columns, rows: r, pages: 1, capped: false };
    },
  } as unknown as SportsConnectClient;
  return { client, asked };
}

test("enrolled means what Sports Connect's own report means: not Cancelled and not Failed", () => {
  assert.equal(enrollmentState("Completed"), "enrolled");
  assert.equal(enrollmentState("Pending"), "pending");
  assert.equal(enrollmentState("Cancelled"), "cancelled");
  assert.equal(enrollmentState("Failed"), "failed");
  assert.equal(enrollmentState("SomethingNew"), "enrolled", "the report excludes only Cancelled and Failed");
});

test("the report is asked for one row per line item and no server-side condition", async () => {
  const { client, asked } = fakeClient(ROWS);
  await readEnrollment(client);
  assert.ok(asked[0].columns.includes("OrderDetailsOrderDetailId"), "without it the report collapses rows by the columns asked");
  assert.deepEqual(asked[0].conditions, [], "an operator the report does not know returns zero rows, not an error");
});

test("a player counts once per division, however many dead orders sit beside the live one", async () => {
  const { client } = fakeClient(ROWS);
  const read = await readEnrollment(client);
  assert.equal(read.lineItems, 8);
  assert.deepEqual(read.notCounted, { cancelled: 2, failed: 2, duplicate: 0 });

  const [fall] = countByDivision(read.enrollments);
  assert.equal(fall.enrolled, 4);
  const girls = fall.divisions.find((d) => d.division === "10U - Girls")!;
  assert.deepEqual(girls, {
    divisionId: "10",
    division: "10U - Girls",
    enrolled: 3,
    pending: 1,
    maxPlayers: 34,
    unallocated: 1,
    teams: 2,
    notEnrolled: 1,
  });
  const boys = fall.divisions.find((d) => d.division === "10U - Boys")!;
  assert.equal(boys.maxPlayers, undefined, "a cap of 0 is no cap");
});

test("the roster is exactly the set the count counts", async () => {
  const { client } = fakeClient(ROWS);
  const read = await readEnrollment(client);
  const players = roster(read.enrollments, "10");
  assert.deepEqual(
    players.map((p) => [p.playerId, p.status, p.orderId]),
    [
      ["p1", "enrolled", "102"],
      ["p2", "enrolled", "201"],
      ["p3", "pending", "300"],
    ],
  );
  assert.equal(players.length, countByDivision(read.enrollments)[0].divisions.find((d) => d.divisionId === "10")!.enrolled);
  assert.deepEqual(
    roster(read.enrollments, "10", () => true).map((p) => [p.playerId, p.status]).at(-1),
    ["p4", "cancelled"],
  );
});

test("a division is picked by every word of its name, and an ambiguous name is not merged", async () => {
  const { client } = fakeClient(ROWS);
  const { enrollments } = await readEnrollment(client);
  assert.deepEqual(matchingDivisions(enrollments, "10U Girls").map((d) => d.divisionId), ["10"]);
  assert.deepEqual(matchingDivisions(enrollments, "11").map((d) => d.division), ["10U - Boys"], "an id works too");
  assert.equal(matchingDivisions(enrollments, "10U").length, 2);
  assert.equal(matchingDivisions(enrollments, "10U Girls", "Spring").length, 0);
});

test("two live registrations of one player in one division are counted once and reported", async () => {
  const { client } = fakeClient([item(G10, "p9", "Completed", "900"), item(G10, "p9", "Completed", "901")]);
  const read = await readEnrollment(client);
  assert.equal(read.enrollments.length, 1);
  assert.equal(read.enrollments[0].orderId, "901", "the newer order wins");
  assert.equal(read.notCounted.duplicate, 1);
});

test("the wait list is read per program, re-checked, and counted beside enrollment — never in it", async () => {
  const { client, asked } = fakeClient(ROWS, [
    waiting(G10, "w1", "Completed", "700"),
    // Left the list (given a place, or gave up): not waiting.
    waiting(G10, "w2", "Cancelled", "701"),
    // Waiting, but already enrolled here: counted once, as enrolled.
    waiting(G10, "p1", "Completed", "702"),
    // The report sent a row outside the program asked: dropped, not trusted.
    waiting({ ...G10, ProgramsProgramId: "99" }, "w3", "Completed", "703"),
    // Not a wait-list item at all.
    { ...waiting(G10, "w4", "Completed", "704"), OrderDetailsDetail: "Cancellation" },
  ]);
  const read = await readEnrollment(client);

  const wl = asked.filter((q) => q.reportKey !== ENROLLMENT_DETAILS.reportKey);
  assert.equal(wl.length, 1, "one wait-list read per program Enrollment Details named");
  assert.deepEqual(
    wl[0].conditions.map((c) => [c.id, c.value]),
    [
      ["ProgramsProgramId", "1"],
      ["OrderDetailsDetail", WAIT_LIST_ITEM],
    ],
  );

  const girls = countByDivision(read.enrollments)[0].divisions.find((d) => d.divisionId === "10")!;
  assert.equal(girls.enrolled, 3, "waiting does not make a player enrolled");
  assert.equal(girls.waitlisted, 1);
  assert.equal(girls.notEnrolled, 1, "a wait-listed player is not counted as not enrolled either");
  assert.deepEqual(
    roster(read.enrollments, "10", (e) => e.state === "waitlisted").map((p) => p.playerId),
    ["w1"],
  );
  assert.match(read.waitList, /sent 5 wait-list line item\(s\) across 1 program\(s\), 3 of them checked .*, 2 still live/);
});
