# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server for Bill.com API integration. The project is in early development.

## GCP

- **Project**: `mcp-servers-487419`
- **Account**: `tseller@gmail.com`
- **gcloud configuration**: `mcp-billcom`

Always activate the correct configuration before running gcloud commands:
```
gcloud config configurations activate mcp-billcom
```

## Development

- `npm run build` — compile TypeScript to `dist/`
- `npm run dev` — run with tsx (loads `.env` automatically)
- `npm start` — run compiled output (loads `.env` automatically)
- `npm test` — node:test unit tests (`src/**/*.test.ts`)
- Inspector: `npx @modelcontextprotocol/inspector node --env-file=.env --import=tsx src/index.ts`
- Drive the **deployed** service end-to-end (handshake + one tool call, against live QBO):
  ```
  export MCP_TOKEN=$(gcloud secrets versions access latest --secret=MCP_API_TOKEN \
    --project=mcp-servers-487419 --account=tseller@gmail.com)
  scripts/mcp-call.sh --list
  scripts/mcp-call.sh qbo_transaction_report '{"startDate":"2026-05-01","endDate":"2026-06-30"}'
  ```

## Architecture

- **ESM project** using TypeScript with Node16 module resolution
- `src/index.ts` — entry point: registers QBO and/or Divvy tools based on available env vars. The stdio path goes through `serveStdio` rather than a hand-connected `StdioServerTransport`, so stdio serves both protocol eras too — see "Protocol eras" below
- `src/qbo-client.ts` — QuickBooks Online API client with OAuth2 token refresh (rolling refresh tokens)
- `src/oauth.ts` — OAuth2 server (Google-backed) for MCP HTTP auth
- `src/http-server.ts` — the Cloud Run deployment's `/mcp`: the sessionful legacy Streamable HTTP transport, the per-request modern handler, and the `/health` both are reported on. `buildServer()` here is the single tool-registration list both eras build from — see "Protocol eras" below
- `src/tools/qbo-accounts.ts` — QBO: list_accounts (flattened rows + paging), account_balances
- `src/tools/qbo-vendors.ts` — QBO: list_vendors, search_vendors (both flattened rows + paging), create_vendor
- `src/tools/list-paging.ts` — the paging vocabularies, each paired with the sentence that names its knobs when a result is over budget (so advice and schema can't drift): `listPaging(defaultMaxResults)` (`startPosition`/`maxResults`/`format`, the QBO entity queries), `OFFSET_PAGING_NARROWING` (the `offset`/`limit` report tools) and `cursorPaging(limits)` (`page`/`pageSize`/`format`, BILL's opaque cursor — the `pageSize` bound comes from `src/divvy-paging.ts` rather than being restated here)
- `src/tools/qbo-transactions.ts` — QBO: list/get/update/create purchases; list/get/create/update deposits (single + batch); list/create transfers; create journal entries; attach/list files. Create tools accept an optional `idempotencyKey`; update tools fetch-then-merge fields QBO requires on full-entity validation (PaymentType/AccountRef on Purchase, DepositToAccountRef on Deposit). The three list tools return **flattened rows** and **page by size as well as row count** — see "Tool result size" below
- `src/qbo-rows.ts` — the flattened row shapes for every list tool (`slimPurchase`/`slimDeposit`/`slimTransfer`/`slimAccount`/`slimVendor`) plus `buildEntityList()`, which packs one page and states `rowCount` / `hasMore` / `nextStartPosition`. `sumField: null` omits `pageTotal` for a listing where a per-page sum states nothing true (a chart of accounts adds assets to liabilities)
- `src/tool-logging.ts` — `runTool()`, the single response path every tool goes through: start/finish logging, `compact()` serialization, and the result-size budget. A handler returns plain data (or a string) and never builds an MCP response itself
- `src/tools/qbo-classes.ts` — QBO: list_classes, create_class (the season tags). Class names are never hardcoded — seasons become year-specific ("Fall 2026")
- `src/tools/qbo-class-reports.ts` — QBO: class_transactions, profit_loss_by_class. **TransactionList cannot return a class**: it silently drops the `klass_name` column (verified against a bogus-column control), so class-aware listing is built on **GeneralLedger**, the only report returning both the posting Account and the Class. The class filter param is `class` (not `classid`, which is ignored) and QBO echoes an applied filter back as `Header.Class` — `QboClient.classReport` asserts that echo so a silently-dropped filter can't pose as a real answer. These reports default to **Accrual** because the company default is Cash, which would break deferred revenue
- `src/tools/qbo-class-writes.ts` — QBO: set_transaction_class (+ batch) — the only sanctioned way to class an existing transaction
- `src/tools/qbo-budgets.ts` — QBO: list_budgets, budget_vs_actuals. The Budget entity is **read-only** via the API (build budgets in the web UI), and there is **no budget report at all**: `BudgetVsActuals`/`BudgetSummary` return `5020 Permission Denied`, exactly as an invented report name does. So budget-vs-actuals is computed — `src/budget-actuals.ts` joins BudgetDetail (account × class) to a P&L summarised by class
- `src/class-lines.ts` — line-preserving edits. Class writes **never rebuild a line**: they deep-copy QBO's own lines and write only `ClassRef`, then `diffPaths` re-checks that nothing else moved and the write is refused if it did. This exists because the update tools' `lines` array can express 3 fields while a live line carries up to 7 (`Id`, `TaxCodeRef`, `BillableStatus`, `CustomerRef`, `LineNum`), so a rebuild silently dropped the rest — hence `mergeLinePatches` (edit by `lineId`) and the explicit `replaceAllLines` flag on the update tools
- `src/scripts/verify-class-live.ts` — read-only live/sandbox verification of the class tooling (`npx tsx src/scripts/verify-class-live.ts`; set `QBO_BASE_URL` + env credentials for a sandbox company)
- `src/tools/qbo-reports.ts` — QBO: transaction_report (optional `cleared` reconcile-status filter), profit_loss, balance_sheet. `qbo_transaction_report` returns **flattened, compact rows** (not QBO's nested report JSON) and **pages automatically** — see "Tool result size" below
- `src/result-size.ts` — the shared tool-result size discipline: `MAX_RESULT_CHARS` budget, `compact()` serialization, `packRows()` paging. Enforced for **every** tool by `runTool`, not opted into per tool
- `src/tools/qbo-reconcile.ts` — QBO: reconcile_worksheet (stitches Uncleared/Cleared TransactionList calls into a per-account reconcile worksheet, computes the difference vs the paper statement's beginning/ending balance), cleared_transactions (list by reconcile status). QBO's Accounting API has **no public Reconcile entity** — you cannot mark items cleared or finalize a reconcile via API; that step is manual in the QBO web UI. The API only exposes reconcile status as the TransactionList report's `cleared` filter (`Reconciled`/`Cleared`/`Uncleared`), filter-only (never per-row), so a worksheet must run one call per status and stitch. Report parsing lives in `parseTransactionList` (src/qbo-client.ts)
- `src/tools/divvy.ts` — Divvy/BILL Spend & Expense: list_transactions and list_cards (both flattened rows + cursor paging), get_transaction, upload_receipt, custom fields, members, budgets, list_pending_action
- `src/divvy-filters.ts` — every filter `divvy_list_transactions` advertises, declared once as a pair: the term BILL is sent (`FILTER_SPECS[name].terms`) and the same question asked of a row that comes back (`.matches`). `FilterCheck` runs the second against every row of every BILL page walked, drops the rows that fail, and reports per filter how it was actually enforced — see "Filters" below
- `src/divvy-paging.ts` — how BILL pages a list, declared once: the query parameters it actually reads (`nextPage`, `max` — never `page`/`page_size`), its own per-endpoint page maximum (transactions 50; cards, budgets, custom fields and custom-field values 100, each probed), `walkBillPages()`, which serves a caller's row count by walking BILL's cursor, and `DIVVY_LIST_TOOLS`/`UNPAGED_DIVVY_LISTS`, the table that requires every `divvy_list_*` tool to declare its paging or its reason for having none. Every paged BILL call goes through `DivvyClient.getBillPage`. It also holds the *witness* each knob is declared with — `PAGING_SPECS` (the query parameter it becomes, and the question asked of the page that comes back) and `PagingCheck`, which every walk runs so a cursor that does not advance stops the walk instead of looping — see "Page size", "Every listing declares its paging" and "A paging knob is witnessed, not assumed" below
- `src/divvy-budgets.ts` — the assembled budget listing (`assembleBudgets`, `slimBudget`). BILL's `/v3/spend/budgets` does not return every budget on these books, so the listing is built from the sources that do name one — see "Budgets" below
- `src/empty-listing.ts` — `describeEmpty()`, the `empty` block a zero-row listing carries. Attached by `buildEntityList` / `buildCursorList` for **every** list tool, so a bare `[]` cannot pose as "there are none" — see "Empty listings" below
- `src/divvy-rows.ts` — the flattened Divvy rows (`slimTransaction`, `slimCard`, `slimCustomField`, `slimCustomFieldValue`) plus `buildCursorList()`, the cursor-paged twin of `buildEntityList()`: same `returned`/`pageTotal`/`hasMore`/`truncatedBy`/`note` vocabulary, but the position is BILL's opaque `nextPage`, and `truncatedBy` has a third value (`cursor`) for the cursor that did not advance. No `rowCount` — BILL's list returns no total, and an omitted count beats an invented one. It carries the `paging` block the same way it carries `filtering`
- `src/protocol-version.ts` — legacy-era protocol-version negotiation + header reconciliation (see "Protocol version" below)
- `src/era-routing.ts` — which leg of `/mcp` serves a request: the SDK's `classifyInboundRequest`, plus the one rule that goes in front of it (an `Mcp-Session-Id` means legacy, always). See "Protocol eras" below
- `src/discover.ts` — what the modern leg advertises, read by **asking** the modern leg rather than restating it beside it. No protocol revision is hard-coded in this repo; a test greps for one
- `src/idempotency.ts` — idempotency-key store for create tools (Firestore in HTTP mode, in-memory for stdio)
- `src/gmail-client.ts` — Gmail attachment fetch for qbo_attach_file (per-account refresh tokens)
- `src/scripts/gmail-link.ts` — one-time bootstrap to mint a Gmail refresh token (`npm run gmail:link`)
- SDK: the v2 package family — `@modelcontextprotocol/server` ^2.0.0 (`McpServer`, `createMcpHandler`, the classifier) and `@modelcontextprotocol/node` ^2.0.0 (the Node transport + `toNodeHandler`). The monolithic v1 `@modelcontextprotocol/sdk` is gone; it never implemented revision 2026-07-28. Tools register with `registerTool(name, { description, inputSchema }, handler)` and a Standard Schema object (`z.object(...)`), not a raw shape, and zod is 4.x (the v2 floor)
- All logging goes to stderr (stdout is MCP protocol)

## Tool result size

A tool result is only useful if the MCP client accepts it. Report tools used to
emit `JSON.stringify(report, null, 2)` of QBO's nested report JSON — ~840 chars
per transaction row, so a two-month TransactionList is ~52,000 chars (~13,000
tokens) and a fiscal year ~470,000. The server never complained; the failure
landed past our edge at the client's per-result cap and looked like a bare
"the tool errored", with nothing in the Cloud Run logs.

The discipline lives in `src/result-size.ts`, and it is the **default** rather
than something each tool opts into: every tool response goes through `runTool`
(`src/tool-logging.ts`), which serializes with `compact()` and refuses anything
over budget. A tool written tomorrow inherits it without knowing this exists;
paging is what turns that refusal into a usable answer.

- `MAX_RESULT_CHARS` (40,000 ≈ 10k tokens) is the budget for one tool result.
- `compact()` — no pretty-printing (indentation alone was ~25% of a payload).
- `packRows()` — takes the largest slice that fits both the caller's `limit`
  and the budget; the result carries `rowCount` (whole range), `offset`,
  `returned`, `hasMore`, `nextOffset` and a `note` saying how to get the rest.
- Over budget is a named error stating the size and how to narrow the request —
  never a silent oversized payload. The advice names **this** tool's paging
  knobs: each vocabulary in `src/tools/list-paging.ts` carries its own sentence
  (`startPosition`/`maxResults`, `offset`/`limit`, `page`/`pageSize`) and the
  tool passes it to `runTool`. One shared sentence naming QBO's knobs was how
  `divvy_list_transactions` came to tell callers to pass four parameters it does
  not accept; a tool with no paging arguments now names none rather than
  borrowing another tool's.

What this means in practice:

- `qbo_transaction_report` and `qbo_cleared_transactions` accept `offset`/`limit`
  and page. **No date range is too long** — a long one just takes more calls.
  Aggregates (`total`) always cover the whole range, not the page.
- `qbo_list_accounts` / `qbo_list_vendors` / `qbo_search_vendors` page the same
  way. An `Account` row keeps id, name, account number, type, classification,
  balance and a sub-account's parent (dropping `FullyQualifiedName`,
  `AccountSubType`, `CurrentBalanceWithSubAccounts`, `CurrencyRef` and the
  usual envelope); a `Vendor` row keeps id, display name, company (only when it
  differs from the display name), email, phone and a non-zero balance (dropping
  `BillRate`, `CostRate`, `Vendor1099`, `V4IDPseudonym`, `PrintOnCheckName` and
  the `GivenName`/`MiddleName`/`FamilyName` re-spellings). `active` is emitted
  only when a row is INACTIVE — these listings are active-only, so `true` on
  every row is a repeated constant. Neither states a `pageTotal`.
  Live books, measured on revision `billcom-mcp-00062-k55`: the whole chart of
  accounts (`qbo_list_accounts {}`, 108 rows) is 12,720 chars, down from a
  53,799-char refusal on a tool that took no arguments to narrow; every vendor
  at the schema's own maximum (`{"maxResults":1000}`, 76 rows) is 4,042 chars,
  down from a 40,590-char refusal.
- `qbo_list_purchases` / `qbo_list_deposits` / `qbo_list_transfers` return
  flattened rows (`src/qbo-rows.ts`) and page on ONE coordinate: when `hasMore`
  is true, call again with `startPosition: nextStartPosition`. `rowCount` is a
  separate `SELECT COUNT(*)` covering the whole filter (QBO's own `totalCount`
  on a query is only the page it just returned); `pageTotal` is this page only,
  because QBO's query language has no SUM. Both `hasMore` reasons are reported
  via `truncatedBy`: `size` (the budget cut the window short) or `window`
  (QBO has rows past what we asked for). `format: "raw"` still returns the full
  entities, and is refused if it exceeds the budget.
- Live books, a fiscal year of purchases (2025-07-01..2026-06-30, 96 rows,
  measured on revision `billcom-mcp-00061-qnj`): 199,955 chars before →
  38,189 for 92 rows, then a 4-row second page at `startPosition: 93`
  (2,083 → 415 chars per row, 5x). The QBO entity's `PurchaseEx` (a JAXB blob),
  `domain`, `sparse`, `SyncToken`, `MetaData`, `PrintStatus`,
  `CustomExtensions` and the USD `CurrencyRef` are envelope; a row keeps date,
  amount, payee/account names WITH their ids, doc number, memo and the
  categorization lines. Full fidelity is one `qbo_get_purchase` away.
  The same range with `format: "raw"` is 123,152 chars and is refused by name.
- Live books, 2026-05-01..2026-06-30: 62 rows, 52,180 chars before → 19,789
  after (2.6x), one page. Roughly 120-180 rows per page at those memo lengths.
- `divvy_list_transactions` returns flattened rows (`src/divvy-rows.ts`) **by
  default**. The row shape existed from the start but behind `compact: true`,
  so the everyday call — the default, at BILL's own maximum page size of 50 —
  was 93,704 chars and failed. A default nobody has to know about is the fix,
  so `format: "raw"` is now the opt-in (for one transaction in full,
  `divvy_get_transaction`). Live books, one 50-row page
  (`{"startDate":"2026-05-01","endDate":"2026-06-30","pageSize":"50"}`,
  measured on revision `billcom-mcp-00063-2qh`): 93,704 chars before →
  **15,216** (6x), and `format: "raw"` on the same page is still 93,704 and
  refused by name. (That date range narrowed nothing when this was measured —
  BILL ignored the parameter names the tool was sending and returned the newest
  page whatever you asked for, issue #29, found while verifying this. It does
  narrow now; see "Filters" below.)
  BILL's cursor is an opaque `nextPage` string, not a row offset, so this list
  keeps `page`/`pageSize` rather than pretending to be `startPosition`; every
  other field means what it does on the QBO lists. When `truncatedBy` is
  `size` the cursor is **withheld**: it points past the whole BILL page, so
  following it would skip the rows the budget dropped — the note says to
  re-request the same `page` with a smaller `pageSize`. `pageSize` is rows and
  is bounded by BILL's own page maximum times the walk cap — see "Page size".
- `qbo_reconcile_worksheet` truncates the *listing* (never the balances or the
  verdict) with an explicit note pointing at the paged tool.
- `qbo_profit_loss` / `qbo_balance_sheet` are hierarchical with nothing sane to
  page, so over budget is a named error stating the size — not a silent failure.
- QBO answers some failures with **HTTP 200 and a `Fault` body** (a malformed
  date, for one). `qboFaultMessage` is checked in `report()`, `query()` and
  `request()` so a Fault raises a tool error instead of flowing on as data.
- Rejected `/mcp` requests are logged with the rpc method, session and
  `MCP-Protocol-Version`, so a request the transport turns away is readable in
  Cloud Run logs rather than an anonymous 400.

## Filters

A filter is only a filter if the rows that come back obey it.

`divvy_list_transactions` sent `start_date` / `end_date` / `budget_id` /
`sync_status` as query parameters. BILL's v3 `/spend/transactions` does not
read those names, and answers **HTTP 200 with an unfiltered page** rather than
rejecting the unknown parameter — so a treasurer reconciling May-June got
August-September, the call succeeded, and nothing in the response said the
filter had done nothing. `budgetId` and `syncStatus` were dead the same way,
as was `since` on `divvy_list_pending_action`.

The wrong parameter name was the instance. The structure that allowed it is
that the tool had no way to tell an applied filter from an ignored one: it sent
a filter and assumed. So a filter is now declared as a **pair**, in
`src/divvy-filters.ts`:

- `terms(value)` — what BILL is asked, in its own `field:operator:value`
  grammar, comma-joined into the `filters` query parameter;
- `matches(row, value)` — the same question asked of a row that came back.

`FilterCheck` runs `matches` over every row of every BILL page, drops the rows
that fail, and returns a `filtering` block in the result saying per filter how
it was really enforced — `server`, `client`, or *sent and not honored*. A
filter BILL ignores therefore cannot silently return the wrong rows; it drops
them and says so. A filter BILL has no field for (`status`) takes the same path
with no terms and reads as client-side rather than posing as a server filter.
The tool's schema and `FILTER_SPECS` are pinned to each other by a test, so a
filter added later cannot be sent without declaring how a row is checked
against it.

What BILL actually supports on `/v3/spend/transactions`, probed against live
books on 2026-09-17 (it validates both field and operator, so this is BILL's
own answer):

| field | operators | notes |
| --- | --- | --- |
| `occurredTime` | `gte`, `lte` only | `eq`/`gt`/`lt`/`ne`/`in`/`sw` are 400s |
| `budgetId` | `eq` | either the base64 `budgetId` or the `bgt_…` uuid |
| `syncStatus` | `eq` | `PENDING`/`SYNCED`/`ERROR`/`MANUAL_SYNCED`/`NOT_SYNCED` |
| `status` | — | not a filter field at all (400) — client-side only |

Traps worth knowing:

- Terms must be **comma-joined** in one `filters` parameter. Repeating the
  parameter, or joining with a semicolon, is accepted and silently ignored —
  the same failure mode as the original bug.
- The value cannot carry a time: `occurredTime:lte:2026-06-26T23:59:59` fails
  the `field:operator:value` split on its colons. A date-only `lte` means that
  day at 00:00, which **excludes the day itself** — `lte:2026-06-26` returns
  nothing for a transaction at `2026-06-26T10:50`. `endDate` therefore asks
  BILL for the day after and trims the overhang client-side; `sentBound` on the
  spec is what keeps that deliberate widening from reading as BILL ignoring us.
- BILL states a transaction's accounting sync on a nested
  `accountingIntegrationTransactions[].syncStatus` (lower-case `"synced"`), and
  omits the record entirely when nothing synced. There is no top-level
  `syncStatus`, so the row this tool advertises as carrying a sync status
  carried none until `slimTransaction` was pointed at the nested record.
- When client-side filtering empties a page, the tool walks BILL's cursor to
  refill it, so a page made mostly of holes does not come back near-empty. That
  is the same walk a `pageSize` bigger than one BILL page uses (see "Page size"
  below), bounded at 10 BILL pages per call; the result states `billPages` when
  more than one was consumed.

Live books, measured on revision `billcom-mcp-00064-rnq`. Asking for
2026-05-01..2026-06-30 returned 50 rows dated 2026-08-02..2026-09-16 (all 50
outside the range); it now returns the 6 rows that are in it, `hasMore: false`,
and none outside. Walked to the last page, the row count grows with the range —
6 / 53 / 105 / 185 for two months, three, four and a half, and fourteen —
where before every one of those asks returned the same newest 50 rows. A
single-day ask (`2026-06-26`..`2026-06-26`) returns the one transaction that
day, which is the midnight-`lte` trap above.

## Page size

A knob a tool advertises has to be one the backend will honor.

`divvy_list_transactions` took `pageSize` as an unbounded string and handed it
straight to BILL, whose `max` on `/v3/spend/transactions` stops at 50. So
`{"startDate":"2025-07-01","endDate":"2026-06-30","pageSize":"100"}` came back
as BILL's raw `400 max: must be less than or equal to 50` (issue #24) — a limit
the code already knew, since the same file held its own `BILL_MAX_PAGE_SIZE = 50`
a few lines away, used for something else. The fact was in the code and not in
the schema, and `divvy-budgets.ts` held three more copies of it as string
literals.

Sweeping for the same shape turned up a second, quieter instance. That tool
spelled BILL's two paging parameters `page` and `page_size`
(`divvy_list_custom_field_values`), and **BILL reads neither name** — it answers
200 and ignores them, which is issue #29's failure mode a fourth time. Probed on
live books 2026-09-18:

| ask | result |
| --- | --- |
| `?page_size=5` | 20 rows — identical to no parameter at all |
| `?max=5` | 5 rows |
| `?page=<cursor>` | the **first** page again, forever |
| `?nextPage=<cursor>` | the actual next page |

So that tool could not page: every call returned the same first 20 NAP codes.

`src/divvy-paging.ts` is where those facts now live, once:

- `BILL_CURSOR_PARAM` / `BILL_PAGE_SIZE_PARAM` — `nextPage` and `max`. Every
  paged BILL call goes through `DivvyClient.getBillPage`, so a method cannot
  invent a third spelling; a test asserts all four listings send those names
  and none of the dead ones.
- `BILL_MAX_PAGE_SIZE` — BILL's own maximum per endpoint, probed rather than
  assumed (it validates `max`, so the 400 is the boundary): transactions **50**,
  cards **100**, budgets **100**, custom-field values **100**, custom fields
  **100**. `divvy-budgets.ts` reads its three page sizes from here instead of
  restating them.
- `billPagingLimits(list)` — what the schema advertises, so the number in the
  description and the number enforced are the same number.
- `DIVVY_LIST_TOOLS` / `UNPAGED_DIVVY_LISTS` — which tool serves which BILL
  list, and which listing-shaped tool takes no cursor *and why*. See "Every
  listing declares its paging" below.

And `pageSize` is **rows, not BILL pages**. BILL's page is a transport detail,
so an ask larger than one is served by `walkBillPages()` — which requests
exactly the rows still wanted (never more than BILL's maximum) and follows
`nextPage` — rather than by a 400 the caller has to learn to loop around. Two
consequences worth knowing:

- Because each request asks for exactly what is left, a page ends on a BILL
  page boundary: `returned` can no longer exceed `pageSize`, and the cursor
  handed back cannot skip rows the call already held. (It used to be able to
  exceed it, for that reason.)
- The walk stops as soon as it has the rows asked for, so the everyday call is
  still exactly one BILL call. It is also bounded by the result-size budget, not
  just by the 10-page cap: rows past the budget would be dropped by `packRows`
  anyway, so a `pageSize: 500` ask spends 3 BILL calls rather than 10.

Live books, measured on revision `billcom-mcp-00068-qvc`. The issue's own call —
a fiscal year at `pageSize: "100"` — was BILL's raw
`400 max: must be less than or equal to 50`; it now returns **86 rows**
(`billPages: 2`, `hasMore: false` — the whole range), 34,364 chars in 1.9s.
`pageSize: "500"` returns 118 rows over **3** BILL pages (not 10), 38,261 chars,
`truncatedBy: "size"`. `pageSize: "501"` is refused by the schema before any
BILL call, with `pageSize must be 500 or fewer rows: BILL's own page holds 50,
and one call walks at most 10 of them.` `divvy_list_custom_field_values`
returns all **72** NAP codes in one call (9,204 chars) where it returned the
same first 20 forever, and `page: nextPage` advances (`Ads/Social Media…` →
`Bank and Credit Card Fees`) instead of repeating page one. The default
transaction call is unchanged at 50 rows / one BILL page / 15,466 chars.

## Cards

A cursor the caller cannot pass back is not paging.

`divvy_list_cards` made one unparameterized `GET /v3/spend/cards` and handed
BILL's answer back whole. BILL's default page is 20, so on books holding 21
cards the tool returned 20 — plus a `nextPage` of `YXJyYXljb25uZWN0aW9uOjE5`
(`arrayconnection:19`) that the tool's schema had no parameter to accept
(issue #43). Nothing in the result said the listing was short: the 21st card
was simply absent. On a company with 200 cards, 180 would have been.

This is #24's family — a BILL paging fact the tool does not expose — but the
mirror image of it: there the tool advertised a knob BILL refused, here BILL
offered a cursor the tool gave nobody a way to follow. #24's fix declared
BILL's paging once (`src/divvy-paging.ts`) and routed every call through it,
which is what made this visible.

So the card list now takes the same cursor vocabulary as every other BILL
listing — `cursorPaging(billPagingLimits('cards'))`, `page`/`pageSize`/`format`
— and runs through `walkBillPages`. Two consequences:

- The default `pageSize` is BILL's own page maximum for this endpoint (**100**,
  probed), not BILL's default of 20, so "list the cards" on these books is one
  BILL call returning every card. A bigger ask walks the cursor, bounded by the
  10-page cap and the result-size budget, exactly as the transaction list does.
- It returns **flattened rows** (`slimCard`) through `buildCursorList`, so it
  inherits the `returned`/`hasMore`/`truncatedBy`/`note` vocabulary and the
  `empty` block — which is what makes a short listing read as short. A physical
  card carries no name, no budget and no period on these books, so those keys
  are omitted rather than carried as nulls; `lastFour` is what names it. There
  is no `pageTotal`: `spent` is each card's own current period, and cards
  sharing a budget's funds would be summed as if they were separate money.
- The zero-row case has a **witness**: every transaction names the card that
  made it, so an empty card list while transactions name cards is a blind
  source, not an empty wallet (`source-blind` — the shape #34 had). It is only
  consulted when the listing has no rows, so the everyday call still costs one
  BILL request; if that witness call fails, the block says `unverified` rather
  than claiming something it did not check.

Live books, measured on revision `billcom-mcp-00069-cqr`. `divvy_list_cards {}`
returns **21 of 21** cards in one BILL call, 6,271 chars, `hasMore: false`, in
0.63s — where it returned 20 of 21 in 9,532 chars with a cursor nothing could
follow. `{"pageSize": 5}` returns 5 rows with `truncatedBy: "window"` and a
cursor that advances; followed to the end it yields **21 distinct cards in 5
calls**. `{"pageSize": 1001}` is refused by the schema before any BILL call
(`pageSize must be 1000 or fewer rows: BILL's own page holds 100, and one call
walks at most 10 of them.`). `format: "raw"` still returns BILL's own objects,
9,789 chars for all 21. A cursor past the end
(`page: "YXJyYXljb25uZWN0aW9uOjI1"`, i.e. `arrayconnection:25`) returns 0 rows
and says which nothing it is: `"meaning": "source-blind"`, with the 9 cards
recent transactions name.

## Every listing declares its paging

The same omission shipped three times: a BILL listing with no way to accept
BILL's cursor. `divvy_list_custom_field_values` spelled the parameters
`page`/`page_size`, which BILL reads as nothing (#24). `divvy_list_cards` took
no arguments at all, so BILL's default page of 20 was the whole answer and the
21st card was unreachable (#43). `divvy_list_custom_fields` took no arguments
either (#46) — and this is the family's quietest member, because on these books
there was no missing row to point at.

Probed against live books 2026-09-23, `GET /v3/spend/custom-fields` pages
exactly like its siblings:

| ask | result |
| --- | --- |
| `?max=1` | 1 field + `nextPage: arrayconnection:0` |
| `?max=1&nextPage=arrayconnection:0` | the **second** field, `nextPage: null` |
| `?max=1&page=arrayconnection:0` | page one again, forever |
| `?max=1&page_size=5` | ignored |
| `?max=101` | `400 max: must be less than or equal to 100` |

So BILL hands this list a cursor and the tool had nowhere to put one. Two field
definitions on these books is the only reason nobody had lost a row — which is
precisely how the card list looked until the books grew past 20.

Each of the three was fixed as an instance because nothing pinned the rule.
`FILTER_SPECS` makes it impossible to advertise a filter without declaring how a
row is checked against it; there was no equivalent making it impossible to
advertise a listing without declaring how it pages. There is now:

- `DIVVY_LIST_TOOLS` (`src/divvy-paging.ts`) maps each listing tool to the BILL
  list it serves, and so to that endpoint's own probed maximum.
- `UNPAGED_DIVVY_LISTS` holds the listing-shaped tools that take no cursor,
  **with the reason** — `divvy_list_budgets` is assembled from several sources
  rather than being one BILL page (#34), `divvy_list_members` calls an endpoint
  BILL answers 404 (#38 owns it), `divvy_list_pending_action` walks the
  transaction list itself and buckets what it finds.
- A test in `divvy-lists.test.ts` walks the **registered** tools and requires
  every `divvy_list_*` to appear in exactly one of the two — and, if paged, to
  really carry `page`/`pageSize` bounded by its own endpoint's maximum, not
  another's. A listing added tomorrow fails the suite until someone says which
  it is. Removing the new entry fails by name:
  `` `divvy_list_custom_fields` is a Divvy listing that is neither declared as a
  BILL paged list nor declared unpaged with a reason ``.

The definitions list also goes through `buildCursorList`, so it speaks the same
result vocabulary as the card list — `returned` / `hasMore` / `truncatedBy` /
`note` — and inherits the `empty` block. Its witness is the transaction list:
BILL re-sends the whole field *definition* on every transaction row, so an
empty definitions list while transactions name NAP CODES and Notes is
`source-blind`, not a company with no custom fields. `slimCustomField` drops
what BILL repeats on every definition (the 2021 `createdTime`, the `global`
flag that only restates the empty scoping, the four budget-scoping arrays that
are empty on every field here) and keeps **both** ids, because
`divvy_list_custom_field_values` and `divvy_update_transaction_custom_fields`
are driven from the uuid. There is no `pageTotal`: a field definition carries
no amount.

The pin covers the **result** shape too (#55). It first checked only the input
vocabulary, and `divvy_list_custom_field_values` passed it — declared, and
really paging — while still handing BILL's envelope back, so a page past the
end of the NAP codes was a bare `{"results":[]}` with no `empty` block. A second
test now drives every tool in `DIVVY_LIST_TOOLS` against a BILL that returns no
rows (a stub answering an empty page to any method, so a new listing needs no
stub of its own) and requires `returned: 0`, `hasMore: false` and an `empty`
block, and no raw `results`. Against the old tool it fails by name:
`` `divvy_list_custom_field_values` is declared a paged BILL list but does not
state `returned` ``.

The values list now goes through `buildCursorList` as `CustomFieldValue` rows
under `values` (`slimCustomFieldValue`: both ids and the label; `deleted` only
when true; no `pageTotal`). Its witness is the `selectedValues` recent
transactions carry on **that** field. A field no recent transaction carries
yields no witness at all, so its empty answer is `unverified` rather than a
`none-found` built on a check that never saw the field — the tool is asked by
id, and a transaction's field block may spell it differently.

Live books, measured on revision `billcom-mcp-00072-lpt`.
`divvy_list_custom_fields {}` returns both definitions (NAP CODES, Notes) in one
BILL call, `returned: 2`, `hasMore: false`, **315 chars** in 0.31s — down from
694 when it handed BILL's envelope back, because the scoping arrays and the 2021
`createdTime` were more than half the payload. `{"pageSize": 1}` returns
`NAP CODES` with `hasMore: true`, `truncatedBy: "window"` and the cursor
`YXJyYXljb25uZWN0aW9uOjA=`; passing that back returns `Notes` with
`hasMore: false` — a second page the tool previously had no parameter to ask
for. A cursor past the end returns `returned: 0` and says which nothing it is:
`"meaning": "source-blind"`, with the 2 fields recent transactions name.
`{"pageSize": 1001}` is refused by the schema before any BILL call
(`pageSize must be 1000 or fewer rows: BILL's own page holds 100, and one call
walks at most 10 of them.`), and `tools/list` advertises the tool's parameters
as `page`, `pageSize` where it advertised none. The sibling listings are unmoved
on the same revision: 21 of 21 cards (6,271 chars), 6 transactions for
2026-05-01..2026-06-30 (2,613 chars), all 72 NAP code values (9,204 chars).

## A paging knob is witnessed, not assumed

A filter is only a filter if the rows obey it; a paging parameter is only paging
if the *pages* obey it. Those are one rule, and only the first half was pinned.

`divvy_list_custom_field_values` advertised `page` and `pageSize` and sent them
as `page` / `page_size`. BILL's v3 `/spend/custom-fields/{id}/values` reads
**neither** — it wants `nextPage` and `max` — and answers 200 with page one
rather than rejecting a parameter it does not know. So the tool's own instruction
("use `page` from `nextPage` in the previous response to walk the full list")
could not be followed: a caller resolving a NAP code got the same first 20 values
on every call behind a `nextPage` that never advanced — an infinite loop wearing
the shape of a working paged API (issue #33). Probed against live books
2026-09-17:

| ask | result |
| --- | --- |
| `?page_size=3` / `?pageSize=3` | 20 rows — BILL's default, `max` is the name |
| `?max=3` | 3 rows |
| `?max=3&page=<cursor>` | page **one** again, and `nextPage` echoes the cursor sent |
| `?max=3&nextPage=<cursor>` | the next 3 rows |

The names were fixed as part of #24 — declared once in `src/divvy-paging.ts`,
with every paged call routed through `DivvyClient.getBillPage`. That is the
instance. The structure that let it ship is that the tool **sent a paging
parameter and assumed**: nothing in a 200 response distinguishes a knob BILL
read from one it ignored, and renaming two parameters leaves the next wrong name
just as silent — which is why this shape has now recurred four times (#29, #24,
#43, #46).

So paging is declared the way filters are (`FILTER_SPECS`), as a pair —
`PAGING_SPECS` in `src/divvy-paging.ts`:

- `param` / `send(value)` — the query parameter BILL is asked on, and the value;
- `honored(page)` — the same question asked of the page that came back.

The witness for a cursor is the cheap and honest one: **a cursor is derived from
a page, so a cursor that re-serves the rows it was derived from has not
advanced.** To have that comparison available on the *next* call, the cursor
handed out is BILL's own with a fingerprint of that page sealed onto it
(`<billCursor>~<fingerprint>`), stripped again in `billPagingParams` so BILL only
ever sees a cursor it issued. A bare BILL cursor pasted by hand still works — it
carries no witness, and the result says that rather than claiming the cursor
advanced.

`PagingCheck` is an accumulator, not a function, because one call can walk
several BILL pages: every page is fingerprinted, so a cursor looping back onto a
page already seen is caught wherever in the walk it happens. That is strictly
stronger than the `next === cursor` string comparison `listPendingAction` and the
budget walker used, which a backend re-serving a page under a *fresh* cursor
string satisfies — it would bucket every row again on each of its 50 (or 10)
requests. Both now use the accumulator.

What a caller sees:

- A cursor that did not advance **stops the walk**: the repeated rows are dropped
  rather than handed back as new ones, no `nextPage` is returned, `truncatedBy` is
  `cursor`, and `hasMore` stays **true** — there are more rows and no way to ask
  for them, so claiming the list ended would be the quieter lie.
- A `paging` block states per knob how it was really enforced, in `filtering`'s
  vocabulary (`server`, or a sentence starting `not honored`). It is reported
  where the caller turned the knob, or where a verdict is `false` — an ordinary
  result is not padded with a sentence about a parameter nobody passed.
- The `pageSize` verdict is **one-sided on purpose**: more rows than `max` asked
  for proves it was ignored, while fewer is just as likely to be the last page.
- An empty page witnesses nothing about the cursor (BILL does end a list with
  one), so it says so instead of reading as a loop.

It runs inside `walkBillPages` — the one funnel every paged BILL listing already
goes through — so transactions, cards, custom fields, values and any listing
added later inherit it without opting in, exactly as they inherit the
result-size budget. A test walks the registered tools and requires every
`page`/`pageSize` a listing advertises to appear in `PAGING_SPECS` with both a
parameter and a witness, and nothing to be declared that no tool offers.

Live books, measured on revision `billcom-mcp-00074-5nn`. Walking NAP CODES
(`{"customFieldId":"tty_tfg5dd0d99325fomhor9osjchg","pageSize":10}`) terminates
in **8 calls** holding **72 values, 72 distinct**, the last page `hasMore: false`
with no cursor — where the same walk before #24 re-served the first 20 forever.
The default call is still one BILL call for all 72 (9,204 chars, 0.30s) and
carries no `paging` block, because no knob was turned and nothing was witnessed
wrong. A cursor that does **not** advance — BILL's cursor for page two carrying
page two's own fingerprint, which is the state BILL re-serving that page produces
— returns `results: []`, no `nextPage`, `truncatedBy: "cursor"` and:

```
"page": "not honored — BILL re-served the same 10 row(s) as a page already
         returned, so the `nextPage` cursor did not advance. Those rows were
         dropped rather than handed back as new ones, and the walk stops here
         rather than looping; the rest of this list cannot be reached by paging"
```

The same cursor *without* the seal returns its 10 rows and says what it cannot
know: `server — sent as `nextPage`; this cursor was not issued by this tool, so
whether it advanced could not be witnessed`. A fiscal year of transactions at
`pageSize: "100"` is unmoved at 86 rows over 2 BILL pages (34,598 chars, up 234
for the `paging` block) and now states the cross-page verdict — `1 cursor page(s)
fetched here, each carrying rows other than the page its cursor came from` —
beside `asked for 100 row(s) a page and BILL returned at most 50`. The sibling
listings on the same revision: 21 of 21 cards (6,271 chars), both custom-field
definitions (315 chars), 6 transactions for 2026-05-01..2026-06-30 (2,613
chars), `divvy_list_pending_action` 1 pending / 0 to review (448 chars), and the
assembled budget listing 15 budgets over its 7 walked pages (3,161 chars) — the
walkers that had the `next === cursor` hole, still walking.

## Budgets

`divvy_list_budgets` returned `{"results":[]}` on books where almost every
transaction names a budget (issue #34). Nothing was wrong with the request:
BILL's `GET /v3/spend/budgets` simply does not return these budgets. Probed
against live books on 2026-09-17, with the endpoint's own documented
parameters:

| ask | rows |
| --- | --- |
| no filter | 0 |
| `retired:eq:false` | 0 |
| `retired:eq:true` | 3 (all retired, all pre-2026) |
| `budgetIds:eq:<an active budget's uuid>` | 0 |
| `parentBudgetId:eq:…`, `isBudgetGroup:eq:…`, `name:sw:…` | 0 |
| `sort=name:asc`, `sort=spent:desc`, `max=100` | 0 |
| `GET /v3/spend/budgets/<that same uuid>` | **the budget, in full, 200** |

So the list endpoint is blind to budgets the same token reads one at a time,
and its unfiltered answer is a strict *subset* of a filtered one — asking it
more cleverly does not help. Two traps: `budgetId` (singular) is rejected as an
unsupported filter field while `budgetIds` is accepted and matches nothing, and
`/v3/spend/budgets/{id}/members` returns `{"results":[]}` for a budget the list
cannot see, so membership is no witness either.

`assembleBudgets` therefore builds the listing from every source that names a
budget — the budget list (asked for `retired:eq:false` **and** `retired:eq:true`,
which between them cover every budget), the cards, and the most recent
transactions — and reads each discovered id back with `GET /v3/spend/budgets/{id}`,
which is BILL confirming the budget exists rather than us asserting it. The
result states per source what it contributed and each row carries `seenOn`, so
a listing that is short because a source went blind says so. The sources run
concurrently and the read-backs eight at a time: ~18 BILL calls, 5.9s from
Cloud Run (8-12s from a laptop).

Live books, measured on revision `billcom-mcp-00066-66r`: 0 budgets before →
**14**, 2,983 chars, including all ten named on recent transactions
("AYSO Region 2B145", "Capital LiveScan Codes", "Fleet US", the tournament
budgets) with both the base64 `id` and the `bgt_…` `uuid` that
`divvy_list_transactions {"budgetId": …}` accepts. BILL's own list contributes
3 of those 14 and says so in words.

## Empty listings

A list that returns no rows must say which kind of nothing it found. This is
#29's shape a third time (`src/divvy-filters.ts`): a call that succeeds and
says nothing true. A silent `[]` reads as "there are none" when it may mean
"this source cannot see them" — which is exactly how a blind budget endpoint
went unnoticed while every transaction named a budget.

`describeEmpty()` (`src/empty-listing.ts`) names three meanings, and the
strongest is only claimable with a **witness** — an independent source that
would have named a row of this kind if one existed:

- `none-found` — a witness was consulted and names none either;
- `source-blind` — a witness names rows this source did not return;
- `unverified` — nothing independent was checked, so the result states what
  the source returned, not that none exist.

`buildEntityList` and `buildCursorList` attach the block whenever `returned` is
0, so every list tool — QBO and Divvy, including ones written later — inherits
it without opting in, the same way they inherit the result-size budget.
`unverified` is the default because it is the honest thing to say when nothing
was checked; a tool that can afford a witness passes one.

## Protocol version

A Streamable HTTP client echoes an `MCP-Protocol-Version` header on every
request after `initialize`, and the SDK transport refuses a version it doesn't
know with `400 Bad Request: Unsupported protocol version` **before any tool
runs**. Tim's Claude connector announces `2026-07-28`, which no released SDK
spoke at the time (v1.30.0, the last of that line, was still on `2025-11-25`) —
so upgrading the SDK did not fix it. That produced 16 silent tool failures in
30 days: nothing ran, nothing was logged about the tool, and the Claude UI
showed a bare "the tool errored".

This server serves `2026-07-28` now, on its own leg (#40) — and that retires
none of what follows. The `initialize` handshake still cannot negotiate a
modern revision (the modern era has no handshake at all), so the supported list
below deliberately stops where it did, and a live 2025 session whose client
echoes a modern version string is still exactly this failure.

The cause was that the same fact — what version this session speaks — lived in
two places that could drift: the version negotiated at `initialize` and the
client's per-request header. `src/protocol-version.ts` makes the negotiated
version authoritative: on an established session, a header naming a version we
don't speak is **reconciled to the negotiated version** rather than refused —
the same thing the transport already does when the header is absent. Nothing is
loosened; the server only ever speaks what it advertised in its own
`initialize` response. Newer and older unknown versions are treated alike, so
next year's version needs no code change.

This is **legacy-era** machinery and only that: the modern era negotiates no
session version, so there is nothing for it to reconcile. `src/era-routing.ts`
keeps it reachable — see "Protocol eras" below, where the same failure
reappeared once and is now pinned by a test.

Three traps worth knowing:

- `NodeStreamableHTTPServerTransport` rebuilds the request via
  `@hono/node-server`, which reads `IncomingMessage.rawHeaders` — **not** the
  `req.headers` object Express middleware mutates. `setRequestHeader()` writes
  both; changing only `req.headers` looks like a working fix and changes
  nothing.
- The `[http] … rejected …` logger is mounted **before** body parsing and auth,
  so it names every refusal — including 401s and unparseable bodies, which
  skipped it when it sat after `express.json()`.
- The reconciler must run on the legacy branch of the era fork, not in front of
  it. Classification is body-primary, so a live 2025 session whose client
  echoes `MCP-Protocol-Version: 2026-07-28` reads as a *malformed modern
  request* unless the session id is read first.

`GET /health` reports the deployed version lists for both eras, the Cloud Run
revision and the policy — so "which protocol does prod speak?" is a curl, not a
deploy or a log dig.

## Protocol eras

An **era** is a behavior family, not a version string. `2024-10-07` through
`2025-11-25` open with the `initialize` handshake and share one wire behavior
(the SDK calls that family `legacy`). `2026-07-28` starts the `modern` era: no
handshake, a `server/discover` advertisement instead, a per-request `_meta`
envelope, and no sessions at all.

`/mcp` serves **both**, on one URL, from one tool registry:

- The **modern** leg is `createMcpHandler(buildServer, { legacy: "reject" })`.
  `legacy: "reject"` is deliberate — the handler's own legacy posture is
  stateless-per-request, which answers a client's `GET` and `DELETE` with `405`
  and would drop the sessions this deployment's clients already hold.
- The **legacy** leg is the sessionful `NodeStreamableHTTPServerTransport`
  wiring that was already here, unchanged.
- `buildServer()` is the single registration list both legs build from, so a
  tool cannot reach one era and not the other. On stdio, `serveStdio` does the
  same job: a hand-connected `StdioServerTransport` serves the 2025 era only,
  whatever SDK it is built against.

`src/era-routing.ts` decides which leg. It delegates to the SDK's own
`classifyInboundRequest` — the same step `createMcpHandler` performs
internally, so the branch cannot disagree with either leg — with **one** rule
in front of it:

> A request naming an `Mcp-Session-Id` is legacy-era traffic. Always.

That rule is not a nicety. The first cut of the era fork classified first, and
reproduced #15 exactly: the Streamable HTTP spec tells a client to echo
`MCP-Protocol-Version` on every request after `initialize`, Tim's connector
echoes `2026-07-28`, and that header with no envelope in the body is — to a
body-primary classifier — a malformed modern request. Every tool call on a live
session was refused `-32602` before any tool ran. Captured from a local build:

```
POST /mcp  Mcp-Session-Id: 8d5380e2-…  MCP-Protocol-Version: 2026-07-28
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
→ 400 -32602 "…names protocol revision 2026-07-28, but the request is missing
             the required per-request envelope key(s)…"
[http] … why=modern claim rejected at envelope (modern-header-without-claim)
```

The narrow fix excepts that one version string and fails again when the spec
moves. The structural one is that a request which names a session has already
said which leg owns it, and no header archaeology may overrule it. An
*unknown* session takes the same branch, so a client whose instance was
replaced gets the legacy leg's `404` telling it to re-`initialize` rather than
a modern parameter error.

What the modern era requires on the wire (SEP-2243), worth knowing because
sending half of it is refused rather than served:

| part | where | if missing |
| --- | --- | --- |
| `io.modelcontextprotocol/protocolVersion` in `params._meta` | body | classified **legacy** — no modern claim at all |
| `MCP-Protocol-Version` header | headers | `-32020`, headers and body disagree |
| `Mcp-Method` header | headers | `-32020`, on every modern request POST |
| `Mcp-Name` header | headers | required for the methods that mirror `params.name` (e.g. `tools/call`) |

`src/discover.ts` is how `/health` knows what the modern leg serves: it asks
it. A claim-less request is refused by a modern-only handler with `-32022` and
`data.supported` names the endpoint's own revisions; the real `server/discover`
is then spoken back at it and the `DiscoverResult` reported. So `/health` and a
modern client read **one** answer, and no protocol revision is hard-coded in
this repo — `discover.test.ts` greps `discover.ts` to keep it that way, and
next year's revision needs no edit here.

Live books, measured on revision `billcom-mcp-00074-kuv`. On the **modern** era
`server/discover` returns `supportedVersions: ["2026-07-28"]`, the `tools`
capability and `serverInfo` in result `_meta`; `tools/list` returns all **42**
tools and `tools/call qbo_account_balances` reaches live QuickBooks (Chase
Checking 118,692.09, Divvy Credit Card Payable 4,190.36). Before this the same
probe was a `-32601`, and every one of those 42 tools was unreachable on that
era. On the **legacy** era nothing moved: `initialize` at `2025-06-18` opens a
session listing the same 42 tools, `scripts/mcp-call.sh` at `2024-11-05` does
too, and `qbo_transaction_report` for 2026-05-01..2026-06-30 is still 62 rows /
total 57,381.82 / 19,789 chars with `divvy_list_transactions` on the same range
still 6 rows / 2,613 chars — the numbers the sections above already record. A
`tools/list` on a live 2025 session whose client announces `2026-07-28` returns
those 42 tools and logs `protocol-version reconciled … client=2026-07-28
negotiated=2025-06-18`; the claim-less `server/discover` residue is the
`-32601` naming both eras and `routedBecause`.

## Pre-session requests

Every current Claude client generation opens a conversation by POSTing
`server/discover` to `/mcp` with no session. `/mcp` required the first request
on a new session to be `initialize`, so it answered `400` with
`{"error":"First request must be an initialize request"}` — not a JSON-RPC
message at all (no `jsonrpc`, no `id`, no numeric code), so nothing in it a
client could act on. 31 of those in one production day (2026-09-17T08:11Z ..
2026-09-18T08:11Z), across three client families; never user-visible only
because the clients fall back to `initialize` on their own. The whole
mitigation was the client happening to retry (#21).

`server/discover` is not a quirk of Tim's connector. It is a **GA'd method of
MCP revision `2026-07-28`** — the revision those clients announce in
`MCP-Protocol-Version` — whose spec says servers **MUST** implement it.

For a while we **answered** it rather than implemented it, deliberately: no
released `@modelcontextprotocol/sdk` did (v1.30.0, the last of that line, spoke
`2025-11-25` at the newest and the string `server/discover` appeared nowhere in
the package), and returning a `DiscoverResult` is the spec's own signal "this is
a *modern* server" — which that build could not have honored for a single
request. So `src/pre-session.ts` answered the body the spec's HTTP
backward-compat rule tells a client to read: a JSON-RPC `-32601` naming the
method, the era, the versions we did speak, and a sentence saying what to send.

**That is over.** The v2 SDK serves `2026-07-28`, `/mcp` routes modern traffic
to a real modern handler, and `server/discover` now returns a real
`DiscoverResult` — the revisions, the capabilities, and `serverInfo` in result
`_meta` (the modern era has no `initialize` response to carry identity in). See
"Protocol eras" above.

What `src/pre-session.ts` still answers is the narrowed residue: a request that
reached the **legacy leg** and cannot open a session there — including a modern
method asked in a shape carrying no modern claim. It no longer calls this
server legacy-era, and no longer says a method we do serve "is not implemented
by this server"; both would now be false. Instead it names `era: "dual"`,
`routedTo: "legacy"`, the classifier's own `routedBecause`, and both ways in.

The module is still deliberately not a case for `server/discover`. Every way
`/mcp`'s legacy leg turns a request away before a session exists goes through
it and answers in JSON-RPC — a method that era does not define (`-32601`), a
body that names no method or a notification with nowhere to go (`-32600`), an
expired/unknown session (`404`/`-32001`, matching the shape the SDK's own
transport sends) and a missing `Mcp-Session-Id`. Each answer also carries a
`reason`, which the rejection logger prints as `why=` — the log line and the
response body are two views of one decision rather than two texts that can
drift.

`GET /health` states `protocol.era` (`"dual"`), the modern leg's own
`DiscoverResult` fields, the legacy version list and
`protocol.preSessionMethodPolicy`, so a client (or a person) can learn what
prod serves without provoking a refusal.

## Environment Variables

### QuickBooks Online (optional — tools enabled if all are set)
- `INTUIT_CLIENT_ID`, `INTUIT_CLIENT_SECRET` — OAuth2 app credentials
- `QBO_REALM_ID` — QuickBooks company ID (obtained during OAuth authorization)
- `QBO_REFRESH_TOKEN` — OAuth2 refresh token (rolling: update after each refresh)
- `QBO_BASE_URL` — optional override (default: production)

### Gmail source for qbo_attach_file (optional)
- `GMAIL_REFRESH_TOKENS` — JSON object mapping account email → OAuth refresh token (scope gmail.readonly). Mint with `npm run gmail:link` (requires the redirect URI, default `http://localhost:8766/callback`, to be allow-listed on the Google OAuth client). For Cloud Run, store as a Secret Manager secret and wire it in deploy.sh.
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` — optional; default to `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`

### Secret rotation (Cloud Run)
Secrets are mounted as `:latest`, resolved at instance start. Never disable a secret version until a newer enabled version exists — a disabled `latest` aborts all new instance startups (the 2026-07-23 burst-502 outage).
