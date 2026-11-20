# PlayMetrics: what an outside tool can reach

Millbrae AYSO is moving registration from Sports Connect to PlayMetrics. This
is what was learned on 2026-11-20 about reading a region's PlayMetrics data
from a server, **before** anything was built. Nothing here has been checked
with a signed-in region login yet; the parts that need one are marked.

## No official API

PlayMetrics publishes no developer API, no API keys and no webhooks for a
club or region. What exists:

- **Exports from the admin UI.** Registration responses, invoice payments,
  subscriptions and schedules export to CSV from inside the admin pages. The
  download links last 7 days.
- **Built-in integrations**, set up by PlayMetrics staff on request (Assignr
  for referee assignment is the one AYSO regions use, through
  success@playmetrics.com).
- **The API the web app itself calls**, `https://api.playmetrics.com/`.

## The community MCP is not a starting point

<https://github.com/sanjibani/playmetrics-mcp> (MIT, two commits) presents 13
read-only tools. Its endpoints are guesses rather than observed calls: its
sign-in is `POST /login` with `{email, password}`, and on 2026-11-20
`POST https://api.playmetrics.com/login` answered **404 page not found**. Its
tests only run against mocks (`respx`), so nothing in it has met the real API.
Its paths (`/clubs`, `/players`, `/registrations`, `/payments`) are the plural
nouns its own comment calls "the convention observed", and do not match the
web app's.

## How the web app really talks to its API

Read from PlayMetrics' own web-app bundles (`app.playmetrics.com/assets/v2/`,
755 chunks, build `64b5581c`):

1. **Sign-in is Google Firebase Auth** (project `playmetrics-prod`), email and
   password: the standard Identity Toolkit `signInWithPassword` exchange. No
   browser is needed, the same way Sports Connect's Cognito sign-in works in
   `src/sportsconnect-client.ts`.
2. **Every API call carries two headers:** `Firebase-Token: <the Firebase ID
   token>` (it lasts an hour and is refreshed), and `pm-access-key: <key>`, a
   per-user, per-role key from `GET /user` once signed in. Switching role (a
   person can be a parent in one club and an admin in another) switches the
   key.
3. **A second factor can be required.** The login response can carry
   `needs_2fa`, which routes to `/verify-2fa` or `/setup-2fa`, and a device can
   be remembered for 90 days (`remember_device`). If the region login has 2FA
   on, a server needs a remembered device or a login without 2FA.
   *Needs a login to confirm.*

## The calls that answer Laura's questions

Paths as the web app calls them (the admin role's views):

| question | calls |
| --- | --- |
| who is registered in a division | `/program_admin/programs`, `/club_admin/players`, `POST /players/query` (filters such as `only_unassigned`), `/register/waitlists` |
| who is unpaid | `/program_admin/invoices`, `/program_admin/subscriptions/monthly_outstanding_report`, `/program_admin/transactions/` |
| which teams need coaches or referees | `/teams`, `/club/coaches`, `/club_admin/club/ref_assignors`, `/program_admin/volunteer_positions/`, `/program_admin/volunteer_event_positions` |
| which volunteers have not finished requirements | `/club_admin/requirements` (requirement templates: system, file upload, waiver; per coach, team staff or volunteer position), `/club_admin/club_background_checkers` |
| the AYSO connection | `/club_admin/sync` (the club's connected systems) |

The response shapes are not known until a region admin login is used.
*Needs a login to confirm.*

## What it would take

- A PlayMetrics login with the region admin role, kept in Secret Manager like
  `SPORTSCONNECT_*`, never in an issue or a chat.
- A read-only client in the style of `src/sportsconnect-client.ts`: an
  allow-list of GET paths, and every response shape probed live before a tool
  relies on it.
- The same `region` access (`src/access.ts`) the Sports Connect tools use.
