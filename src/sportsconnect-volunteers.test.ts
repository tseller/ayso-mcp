import { test } from "node:test";
import assert from "node:assert/strict";
import {
  divisionAge,
  filterVolunteers,
  gaps,
  problemsOf,
  teamStaffing,
  type Volunteer,
} from "./sportsconnect-volunteers.js";
import { unpaid, type Enrollment } from "./sportsconnect-enrollment.js";
import { histories } from "./sportsconnect-history.js";

// Names and contact details are invented — this repository is public.
let n = 0;
const vol = (o: Partial<Volunteer>): Volunteer => ({
  id: String(++n),
  personId: String(n),
  name: `Vol ${n}`,
  email: "v@example.com",
  phone: "555-0100",
  role: "Head Coach",
  program: "MY 2026 Fall CORE",
  division: "10U - Girls",
  team: "10UG-01",
  riskStatus: "Green",
  coachLicence: "10U Coach",
  refereeGrade: null,
  ...o,
});

test("division age reads the U number, with or without a leading zero", () => {
  assert.equal(divisionAge("08U - Boys"), 8);
  assert.equal(divisionAge("10U - Girls"), 10);
  assert.equal(divisionAge("Intermediate (14U) Coach"), 14);
  assert.equal(divisionAge("Board Member and Referee Volunteers"), null);
});

test("a coach licensed for the division's age or older is in order", () => {
  assert.deepEqual(problemsOf(vol({})), []);
  assert.deepEqual(problemsOf(vol({ coachLicence: "Advanced (19U) Coach" })), []);
});

test("a coach licensed below the division's age, or not at all, is a gap", () => {
  assert.match(problemsOf(vol({ division: "12U - Boys", coachLicence: "10U Coach" }))[0], /holds 10U Coach, which covers 10U/);
  assert.match(problemsOf(vol({ role: "Assistant Coach", coachLicence: null }))[0], /Assistant Coach with no coaching licence/);
});

test("risk status follows AYSO's colour key", () => {
  assert.deepEqual(problemsOf(vol({ role: "Referee", riskStatus: "Blue", coachLicence: null, refereeGrade: "Regional Referee" })), []);
  assert.match(problemsOf(vol({ riskStatus: "Blue" }))[0], /Blue .* registered as Head Coach/);
  assert.match(problemsOf(vol({ riskStatus: "Expired" }))[0], /must renew/);
  assert.match(problemsOf(vol({ riskStatus: "None" }))[0], /consent form/);
  assert.match(problemsOf(vol({ riskStatus: null }))[0], /no risk status on file/);
  assert.match(problemsOf(vol({ riskStatus: "Purple" }))[0], /not one AYSO's colour key names/);
});

test("a referee needs a grade, and an 8U Official on an older division is a gap", () => {
  const ref = { role: "Referee", coachLicence: null };
  assert.deepEqual(problemsOf(vol({ ...ref, refereeGrade: "Regional Referee" })), []);
  assert.match(problemsOf(vol({ ...ref, refereeGrade: null }))[0], /no referee grade/);
  assert.match(problemsOf(vol({ ...ref, refereeGrade: "8U Official", division: "12U - Boys" }))[0], /covers 8U games/);
  assert.deepEqual(problemsOf(vol({ ...ref, refereeGrade: "8U Official", division: "08U - Boys" })), []);
});

test("team parents are not held to coach or referee rules", () => {
  assert.deepEqual(problemsOf(vol({ role: "Team Parent", coachLicence: null })), []);
  assert.equal(gaps([vol({ role: "Team Parent", coachLicence: null })]).length, 0);
});

test("filters match every word, case-insensitively", () => {
  const vs = [vol({ role: "Head Coach" }), vol({ role: "Assistant Coach" }), vol({ role: "Referee", division: "12U - Boys" })];
  assert.equal(filterVolunteers(vs, { role: "coach" }).length, 2);
  assert.equal(filterVolunteers(vs, { role: "head coach" }).length, 1);
  assert.equal(filterVolunteers(vs, { division: "12u boys" }).length, 1);
});

test("team staffing: teams come from where the players are, and say what they are missing", () => {
  const players = [
    { team: "10UG-01", division: "10U - Girls" },
    { team: "10UG-01", division: "10U - Girls" },
    { team: "10UG-02", division: "10U - Girls" },
    { team: "Unallocated", division: "10U - Girls" },
  ];
  const staff = teamStaffing(players, [
    vol({ team: "10UG-01" }),
    vol({ team: "10UG-01", role: "Referee" }),
    vol({ team: "10UG-01", role: "Team Parent" }),
  ]);
  assert.equal(staff.length, 2, "Unallocated is not a team");
  const [one, two] = staff;
  assert.equal(one.players, 2);
  assert.equal(one.headCoaches.length, 1);
  assert.equal(one.referees.length, 1);
  assert.deepEqual(one.others.map((o) => o.role), ["Team Parent"]);
  assert.equal(one.needs, undefined);
  assert.deepEqual(two.needs, ["no head coach", "no referee registered to this team"], "a team with players and no volunteers still appears");
});

const enr = (o: Partial<Enrollment>): Enrollment => ({
  programId: "1",
  program: "Fall",
  divisionId: "10",
  division: "10U - Girls",
  maxPlayers: null,
  endDate: null,
  playerId: String(++n),
  player: `Kid ${n}`,
  gender: null,
  birthDate: null,
  team: null,
  orderId: String(n),
  orderDate: null,
  state: "enrolled",
  balance: 0,
  account: "Pat Example",
  email: "pat@example.com",
  phone: "555-0100",
  ...o,
});

test("unpaid: owing, pending and declined — and a cancelled balance is never owed", () => {
  const u = unpaid([
    enr({}),
    enr({ balance: 120 }),
    enr({ state: "pending" }),
    enr({ state: "failed", balance: 228.5 }),
    enr({ state: "cancelled", balance: 328.5 }),
  ]);
  assert.equal(u.owing.length, 1);
  assert.equal(u.owing[0].balance, 120);
  assert.equal(u.pending.length, 1);
  assert.equal(u.declined.length, 1);
  assert.equal(u.declined[0].division, "10U - Girls");
  assert.equal(u.declined[0].balance, undefined, "a declined attempt's balance is not money owed");
});

const li = (o: Record<string, string | null>) => ({
  OrderDetailsOrderDetailId: String(++n),
  OrdersOrderId: "100",
  OrdersOrderDate: "6/1/2022 3:19:54 AM",
  OrdersPaymentStatus: "Completed",
  OrderDetailsDetail: "Division Price",
  ProgramsProgramName: "2022 Fall Soccer",
  DivisionsDivisionName: "08U - Girls",
  TeamsTeamName: "08UG-03",
  PlayersPlayerId: "7",
  PlayersFirstName: "Kid",
  PlayersLastName: "Example",
  UsersFirstName: "Pat",
  UsersLastName: "Example",
  ...o,
});

test("player history: one row per season, from the registration line, live over cancelled", () => {
  const [p] = histories([
    li({}),
    li({ OrderDetailsDetail: "AYSO Membership Fee" }),
    li({ OrderDetailsDetail: "Early Bird Discount" }),
    // 2024: the original order cancelled by a transfer, the new one live
    li({ ProgramsProgramName: "2024 Fall Soccer", DivisionsDivisionName: "10U - Girls", OrdersOrderId: "300", OrdersOrderDate: "5/1/2024", OrdersPaymentStatus: "Cancelled" }),
    li({ ProgramsProgramName: "2024 Fall Soccer", DivisionsDivisionName: "10U - Girls", OrdersOrderId: "301", OrdersOrderDate: "5/1/2024", TeamsTeamName: "10UG-02" }),
    li({ ProgramsProgramName: "2023 Fall Soccer", OrdersOrderId: "200", OrdersOrderDate: "5/1/2023", OrderDetailsDetail: "Wait List Registration" }),
  ]);
  assert.equal(p.player, "Kid Example");
  assert.deepEqual(
    p.seasons.map((s) => [s.program, s.status, s.team]),
    [
      ["2024 Fall Soccer", "enrolled", "10UG-02"],
      ["2023 Fall Soccer", "waitlisted", "08UG-03"],
      ["2022 Fall Soccer", "enrolled", "08UG-03"],
    ],
  );
});
