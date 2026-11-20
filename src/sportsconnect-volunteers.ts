/**
 * Volunteers: who is coaching, refereeing and helping, on which team, and
 * whether they are cleared and trained for it.
 *
 * Read from the report wizard's *All Volunteers* report, asked with no
 * condition — it is a few hundred rows (~6s) and every filter is applied here,
 * as the enrollment tools do. Probed live 2026-11-20:
 *
 *  - **A row is one volunteer role, not one person.** A parent who is head
 *    coach of one team and a referee is two rows, each with its own team and
 *    division. `VolunteerInfoVolunteerInfoId` names the role sign-up and is
 *    always selected, so de-duplication is ours (the report returns distinct
 *    rows over the columns asked for, like Enrollment Details).
 *  - **Training comes from AYSO, not from the region.** `CoachingLicenseLevel`
 *    (`8U Coach` … `Advanced (19U) Coach`) and `RefereeGrade` (`8U Official`,
 *    `Regional Referee`, …) are the volunteer's AYSO certification as Sports
 *    Connect holds it. The individual courses behind them (Safe Haven,
 *    concussion, cardiac arrest, SafeSport) are not in any report this login
 *    can run, so this module never claims a course is done or missing — only
 *    whether the licence or grade on file covers the job.
 *  - **`RiskStatus` is AYSO's background-check colour** (AYSO wiki, "AYSO
 *    Volunteer Status Risk Color Key"). Green may volunteer in any position;
 *    Blue is a youth volunteer (referee, or supervised roles only); Expired must
 *    renew; None has not completed the background-check consent. Blank means
 *    Sports Connect sent nothing for the role.
 *  - **The report holds the current membership year only.** Asked for any
 *    earlier program by name it returns zero rows, so volunteer history is not
 *    readable here.
 */

import type { ReportQuery, SportsConnectClient } from "./sportsconnect-client.js";
import { nameMatches } from "./sportsconnect-orders.js";

export const ALL_VOLUNTEERS = {
  reportKey: "ReportWizardAllVolunteersNewRegistration",
  modelId: "ReportWizard_AllVolunteers_New_Registration",
} as const;

const COLUMNS = [
  "VolunteerInfoVolunteerInfoId",
  "VolunteerMasterVolunteerMasterId",
  "VolunteerAddressDetailIdaddressDetailFirstName",
  "VolunteerAddressDetailIdaddressDetailLastName",
  "VolunteerAddressDetailIdaddressDetailEmail",
  "VolunteerCellPhone",
  "VolunteerTypesVolunteerRoleDescription",
  "ProgramsProgramName",
  "DivisionsDivisionName",
  "TeamsTeamName",
  "RiskStatus",
  "CoachingLicenseLevel",
  "RefereeGrade",
] as const;

type Row = Record<(typeof COLUMNS)[number], string | null>;

export interface Volunteer {
  /** The role sign-up (one person can hold several). */
  id: string;
  /** The person, the same across their roles. */
  personId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  program: string | null;
  division: string | null;
  team: string | null;
  riskStatus: string | null;
  coachLicence: string | null;
  refereeGrade: string | null;
}

const blank = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);

/** Sports Connect's team placeholder for a volunteer or player not yet on a team. */
const UNALLOCATED = /^unallocated$/i;

export function teamOf(team: string | null): string | null {
  return team && !UNALLOCATED.test(team) ? team : null;
}

export function toVolunteer(r: Row): Volunteer {
  return {
    id: r.VolunteerInfoVolunteerInfoId ?? "",
    personId: blank(r.VolunteerMasterVolunteerMasterId),
    name:
      [blank(r.VolunteerAddressDetailIdaddressDetailFirstName), blank(r.VolunteerAddressDetailIdaddressDetailLastName)]
        .filter(Boolean)
        .join(" ") || "(no name)",
    email: blank(r.VolunteerAddressDetailIdaddressDetailEmail),
    phone: blank(r.VolunteerCellPhone),
    role: blank(r.VolunteerTypesVolunteerRoleDescription) ?? "(no role)",
    program: blank(r.ProgramsProgramName),
    division: blank(r.DivisionsDivisionName),
    team: teamOf(blank(r.TeamsTeamName)),
    riskStatus: blank(r.RiskStatus),
    coachLicence: blank(r.CoachingLicenseLevel),
    refereeGrade: blank(r.RefereeGrade),
  };
}

export interface VolunteerRead {
  volunteers: Volunteer[];
  /** Rows the report sent, before one-per-role de-duplication. */
  rows: number;
  capped: boolean;
  totalRecords: number;
}

export async function readVolunteers(client: SportsConnectClient): Promise<VolunteerRead> {
  const q: ReportQuery = { ...ALL_VOLUNTEERS, columns: [...COLUMNS], conditions: [] };
  const page = await client.report(q);
  const byId = new Map<string, Volunteer>();
  for (const r of page.rows as Row[]) {
    const v = toVolunteer(r);
    if (!byId.has(v.id)) byId.set(v.id, v);
  }
  return { volunteers: [...byId.values()], rows: page.rows.length, capped: page.capped, totalRecords: page.totalRecords };
}

// ---------------------------------------------------------------------------
// The rules: is a volunteer cleared and trained for the job they hold?

/** AYSO's risk colours, in its own words (AYSO wiki, Volunteer Status Risk Color Key). */
export const RISK_STATUS: Record<string, { cleared: boolean; meaning: string }> = {
  green: { cleared: true, meaning: "may volunteer in any position" },
  blue: { cleared: true, meaning: "youth volunteer: may referee, or help where registered adults supervise" },
  yellow: { cleared: false, meaning: "restricted from coaching" },
  orange: { cleared: false, meaning: "restricted from handling funds" },
  brown: { cleared: false, meaning: "restricted from coaching and from handling funds" },
  red: { cleared: false, meaning: "ineligible to volunteer" },
  expired: { cleared: false, meaning: "background check expired; must renew" },
  none: { cleared: false, meaning: "has not completed the background-check consent form" },
};

/** The age a division plays at, from its name (`10U - Girls` → 10), or null for a non-age division. */
export function divisionAge(division: string | null): number | null {
  const m = division?.match(/\b0*(\d{1,2})\s*U\b/i);
  return m ? Number(m[1]) : null;
}

/**
 * The oldest age group a coaching licence covers. AYSO certifies coaches by
 * age group (`8U Coach` … `Intermediate (14U) Coach`, `Advanced (19U) Coach`),
 * and a coach is certified for the age group they coach and younger.
 */
export function licenceAge(licence: string | null): number | null {
  return divisionAge(licence);
}

const COACH_ROLES = /\b(head|assistant)\s+coach\b/i;
const REFEREE_ROLES = /\breferee\b/i;

export interface Gap {
  volunteer: Volunteer;
  /** Each thing that is not in order, as a sentence. */
  problems: string[];
}

/** Everything about one volunteer role that is not in order, or none. */
export function problemsOf(v: Volunteer): string[] {
  const problems: string[] = [];
  const risk = v.riskStatus ? RISK_STATUS[v.riskStatus.toLowerCase()] : undefined;
  if (!v.riskStatus) problems.push("no risk status on file in Sports Connect");
  else if (!risk) problems.push(`risk status "${v.riskStatus}" is not one AYSO's colour key names`);
  else if (!risk.cleared) problems.push(`risk status ${v.riskStatus}: ${risk.meaning}`);
  else if (v.riskStatus.toLowerCase() === "blue" && COACH_ROLES.test(v.role)) {
    problems.push(`risk status Blue (${risk.meaning}) but registered as ${v.role}`);
  }

  if (COACH_ROLES.test(v.role)) {
    const need = divisionAge(v.division);
    const has = licenceAge(v.coachLicence);
    if (!v.coachLicence) problems.push(`${v.role} with no coaching licence on file`);
    else if (need != null && has != null && has < need) {
      problems.push(`${v.role} in ${v.division} holds ${v.coachLicence}, which covers ${has}U and younger`);
    }
  }
  if (REFEREE_ROLES.test(v.role)) {
    const age = divisionAge(v.division);
    if (!v.refereeGrade) problems.push("Referee with no referee grade on file");
    else if (/\b8U Official\b/i.test(v.refereeGrade) && age != null && age > 8) {
      problems.push(`${v.refereeGrade} registered for ${v.division}; that grade covers 8U games`);
    }
  }
  return problems;
}

export function gaps(volunteers: Volunteer[]): Gap[] {
  return volunteers
    .map((volunteer) => ({ volunteer, problems: problemsOf(volunteer) }))
    .filter((g) => g.problems.length > 0);
}

// ---------------------------------------------------------------------------
// Filters and team staffing

export interface VolunteerFilter {
  role?: string;
  division?: string;
  team?: string;
  name?: string;
}

export function filterVolunteers(volunteers: Volunteer[], f: VolunteerFilter): Volunteer[] {
  return volunteers.filter(
    (v) =>
      (!f.role || nameMatches(f.role, v.role)) &&
      (!f.division || nameMatches(f.division, v.division ?? "")) &&
      (!f.team || nameMatches(f.team, v.team ?? "")) &&
      (!f.name || nameMatches(f.name, v.name)),
  );
}

export interface TeamStaff {
  team: string;
  division: string;
  players: number;
  headCoaches: string[];
  assistantCoaches: string[];
  referees: string[];
  others: Array<{ name: string; role: string }>;
  /** What the team is missing, as sentences; absent when nothing is. */
  needs?: string[];
}

/**
 * Every team in the players' own team assignments, with the volunteers whose
 * role names that team. A team is taken from the enrollment (where the players
 * are), so a team with players and no volunteers at all still appears — that
 * is exactly the team that needs a coach.
 */
export function teamStaffing(
  players: Array<{ team: string | null; division: string }>,
  volunteers: Volunteer[],
): TeamStaff[] {
  const key = (division: string, team: string) => `${division}\u0000${team}`;
  const teams = new Map<string, TeamStaff>();
  const ensure = (division: string, team: string): TeamStaff => {
    const k = key(division, team);
    let t = teams.get(k);
    if (!t) {
      t = { team, division, players: 0, headCoaches: [], assistantCoaches: [], referees: [], others: [] };
      teams.set(k, t);
    }
    return t;
  };
  for (const p of players) {
    const team = teamOf(p.team);
    if (team) ensure(p.division, team).players++;
  }
  for (const v of volunteers) {
    if (!v.team || !v.division) continue;
    const t = teams.get(key(v.division, v.team));
    if (!t) continue; // a team with no enrolled players is not a team this answers for
    if (/\bhead\s+coach\b/i.test(v.role)) t.headCoaches.push(v.name);
    else if (/\bassistant\s+coach\b/i.test(v.role)) t.assistantCoaches.push(v.name);
    else if (REFEREE_ROLES.test(v.role)) t.referees.push(v.name);
    else t.others.push({ name: v.name, role: v.role });
  }
  return [...teams.values()]
    .map((t) => {
      const needs: string[] = [];
      if (t.headCoaches.length === 0) needs.push("no head coach");
      if (t.referees.length === 0) needs.push("no referee registered to this team");
      return needs.length ? { ...t, needs } : t;
    })
    .sort(
      (a, b) =>
        a.division.localeCompare(b.division, "en", { numeric: true }) ||
        a.team.localeCompare(b.team, "en", { numeric: true }),
    );
}
