import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCursorList,
  slimCard,
  slimCustomField,
  slimCustomFieldValue,
  slimTransaction,
} from "./divvy-rows.js";
import { FILTER_SPECS, FilterCheck, billFilterParam } from "./divvy-filters.js";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";
import { MAX_RESULT_CHARS, compact, overBudget } from "./result-size.js";
import { runTool, type ToolResult } from "./tool-logging.js";
import {
  CURSOR_PAGING_NARROWING,
  LIST_PAGING,
  LIST_PAGING_NARROWING,
  cursorNarrowing,
  cursorPaging,
} from "./tools/list-paging.js";
import {
  BILL_CURSOR_PARAM,
  BILL_MAX_PAGE_SIZE,
  BILL_PAGE_SIZE_PARAM,
  DIVVY_LIST_TOOLS,
  MAX_BILL_PAGES_PER_CALL,
  UNPAGED_DIVVY_LISTS,
  billPagingLimits,
  openCursor,
  type BillListName,
} from "./divvy-paging.js";

/**
 * A BILL Spend & Expense transaction in the shape the list endpoint returns —
 * a representative fixture, sized to the live one (~1.9KB each, which is how
 * 50 of them made 93,704 characters). Everything past the dozen fields a
 * treasurer reads is scaffolding: the card and merchant descriptors, the
 * review chain, the custom-field *definitions* re-sent on every row, the sync
 * bookkeeping and the currency block that is always USD.
 */
function liveTransaction(i: number) {
  return {
    id: `VHJhbnNhY3Rpb246NWJlNmI3MzIt${String(i).padStart(4, "0")}LTQ1ZjItOGY0ZC0zM2Q5`,
    uuid: `txr_bfjbecj1il3393vgvevotvju${String(i).padStart(2, "0")}`,
    occurredTime: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T14:22:05.000Z`,
    clearedTime: `2026-05-${String((i % 28) + 2).padStart(2, "0")}T03:11:47.000Z`,
    createdTime: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T14:22:09.113Z`,
    updatedTime: `2026-05-${String((i % 28) + 2).padStart(2, "0")}T09:04:52.884Z`,
    status: i % 9 === 0 ? "DECLINED" : "CLEARED",
    amount: 206.37 + i,
    originalAmount: 206.37 + i,
    currency: "USD",
    originalCurrency: "USD",
    exchangeRate: 1,
    fees: 0,
    transactionType: "PURCHASE",
    userName: "Timothy Eller",
    userUuid: "usr_2d9f4c1a8b7e4f6a9c3d5e8f1a2b3c4d",
    userEmail: "tseller@gmail.com",
    merchantName: "Refilled.com",
    merchantDescriptor: "REFILLED.COM *SUBSCRIPTION 888-555-0142 DE",
    merchantCategoryCode: "5968",
    merchantCategoryName: "Direct Marketing — Continuity/Subscription Merchants",
    budgetId: "bdg_7f3a1c9e2d4b6a8c0e2f4a6b8c0d2e4f",
    budgetName: "Operations",
    cardId: "crd_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    cardName: "Ops virtual card",
    cardLastFour: "4417",
    cardType: "VIRTUAL",
    isLocked: i % 5 === 0,
    receiptRequired: true,
    receiptStatus: i % 3 === 0 ? "ATTACHED" : "MISSING",
    receipts: i % 3 === 0 ? [{ id: `rct_${i}`, url: `https://receipts.bill.com/${i}.jpg` }] : [],
    reviewRequired: true,
    reviewers: [
      {
        userUuid: "usr_9c3d5e8f1a2b3c4d2d9f4c1a8b7e4f6a",
        userName: "Timothy Eller",
        status: "WAITING",
        role: "BUDGET_OWNER",
        respondedTime: null,
      },
    ],
    // BILL states the accounting sync on a nested integration record, and
    // omits the record entirely for a transaction that has not synced — there
    // is no top-level `syncStatus`, which is why the row used to carry none.
    accountingIntegrationTransactions:
      i % 4 === 0
        ? [
            {
              id: `QWNjb3VudGluZ0ludGVncmF0aW9uVHJhbnNhY3Rpb246${i}`,
              billable: false,
              integrationTxId: String(1000 + i),
              syncStatus: "synced",
              syncMessage: "Synced to QBO",
              integrationType: "qbo",
              integrationId: "be28f5ec-7839-41ba-b646-5000d62c6c71",
              syncRequestId: `e80eb15d-5287-4052-b05e-e2a0cbf939${String(i).padStart(2, "0")}`,
            },
          ]
        : null,
    glAccountId: null,
    glAccountName: null,
    customFields: [
      {
        uuid: "cf_nap_codes",
        customFieldId: "cf_nap_codes",
        name: "NAP CODES",
        type: "SELECT",
        isRequired: true,
        isActive: true,
        selectedValues: [{ value: `NAP-${100 + (i % 12)}`, label: `NAP-${100 + (i % 12)}` }],
        note: null,
      },
      {
        uuid: "cf_notes",
        customFieldId: "cf_notes",
        name: "Notes",
        type: "NOTE",
        isRequired: false,
        isActive: true,
        selectedValues: [],
        note: i % 2 === 0 ? "Monthly subscription renewal" : "",
      },
    ],
  };
}

/**
 * `n` transactions starting at `from`. The offset matters wherever a fixture
 * serves several pages: BILL's rows differ from page to page, and a stub that
 * re-serves identical rows under a fresh cursor is the very thing `PagingCheck`
 * now stops the walk on (issue #33), so a multi-page fixture has to be as
 * distinct as the real list is.
 */
const page = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => liveTransaction(from + i));

test("the default call at BILL's own maximum page size fits the budget; raw does not", () => {
  const raw = page(50);
  const rawSize = compact({ results: raw, nextPage: "cursor" }).length;
  assert.ok(
    rawSize > MAX_RESULT_CHARS,
    `a 50-row raw page should be over budget, was ${rawSize}`,
  );

  const rows = buildCursorList({
    entity: "Transaction",
    key: "transactions",
    rows: raw.map(slimTransaction),
    nextPage: "cursor",
  });
  const rowSize = compact(rows).length;
  assert.ok(rowSize < MAX_RESULT_CHARS, `a 50-row page should fit, was ${rowSize}`);
  assert.equal(rows.returned, 50);
  assert.equal((rows.transactions as unknown[]).length, 50);
  // The whole point of the flip: this is the default path, and it is small.
  assert.ok(rowSize < rawSize / 4, `rows ${rowSize} vs raw ${rawSize}`);
});

test("a row keeps both ids and the filled custom fields, and drops the empty ones", () => {
  const row = slimTransaction(liveTransaction(1));
  assert.equal(row.id, liveTransaction(1).id);
  assert.equal(row.uuid, liveTransaction(1).uuid);
  assert.equal(row.date, "2026-05-02");
  assert.equal(row.merchant, "Refilled.com");
  assert.equal(row.user, "Timothy Eller");
  assert.equal(row.amount, 207.37);
  // Odd rows have an empty Notes field: a key carrying "" is payload for nothing.
  assert.deepEqual(row.fields, { "NAP CODES": "NAP-101" });
  assert.deepEqual(slimTransaction(liveTransaction(2)).fields, {
    "NAP CODES": "NAP-102",
    Notes: "Monthly subscription renewal",
  });
});

test("more pages at BILL: hasMore carries the cursor to follow", () => {
  const result = buildCursorList({
    entity: "Transaction",
    key: "transactions",
    rows: page(10).map(slimTransaction),
    nextPage: "eyJvZmZzZXQiOjEwfQ==",
  });
  assert.equal(result.hasMore, true);
  assert.equal(result.truncatedBy, "window");
  assert.equal(result.nextPage, "eyJvZmZzZXQiOjEwfQ==");
  assert.match(String(result.note), /page: nextPage/);
});

test("the last page states hasMore false and no cursor", () => {
  const result = buildCursorList({
    entity: "Transaction",
    key: "transactions",
    rows: page(3).map(slimTransaction),
  });
  assert.equal(result.hasMore, false);
  assert.equal(result.nextPage, undefined);
  assert.equal(result.note, undefined);
  assert.equal(result.pageTotal, 206.37 + 207.37 + 208.37);
});

test("when the budget cuts a page short, the cursor is withheld — following it would skip rows", () => {
  // Far more rows than the budget holds, all inside ONE BILL page.
  const result = buildCursorList({
    entity: "Transaction",
    key: "transactions",
    rows: page(400).map(slimTransaction),
    nextPage: "eyJvZmZzZXQiOjQwMH0=",
  });
  assert.ok(compact(result).length <= MAX_RESULT_CHARS);
  assert.equal(result.hasMore, true);
  assert.equal(result.truncatedBy, "size");
  assert.ok((result.returned as number) < 400);
  // BILL's cursor starts after all 400 rows; handing it back here would lose
  // the ones the budget dropped. The way forward is a smaller pageSize.
  assert.equal(result.nextPage, undefined);
  assert.match(String(result.note), /same `page`/i);
  assert.match(String(result.note), /smaller `pageSize`/);
});

test("the over-budget error names knobs the tool actually has", async () => {
  const fat = { blob: "x".repeat(MAX_RESULT_CHARS + 10) };
  const res = await runTool("divvy_list_transactions", {}, async () => fat, {
    narrowing: CURSOR_PAGING_NARROWING,
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /over the 40,000-character tool-result budget/);
  assert.match(text, /pageSize/);
  assert.match(text, /page: nextPage/);
  // The defect this replaced: advising four parameters this tool does not take.
  for (const absent of ["maxResults", "startPosition", "nextOffset", "offset"]) {
    assert.doesNotMatch(text, new RegExp(absent), `advice names ${absent}, which the tool lacks`);
  }
});

test("a tool with no paging arguments is given no knobs to turn", () => {
  // `divvy_list_cards` was the example here until it grew real ones (issue
  // #43), and `divvy_list_custom_fields` until it grew them too (issue #46).
  // `divvy_list_members` is the honest case: BILL answers its endpoint 404, so
  // there is no page to ask for a second of (issue #38).
  const text = overBudget("divvy_list_members", 50_000);
  for (const absent of ["maxResults", "startPosition", "offset", "pageSize", "format"]) {
    assert.doesNotMatch(text, new RegExp(absent));
  }
  assert.match(text, /Narrow the request/);
});

/**
 * The advice and the schema are two spellings of the same fact — which knobs
 * this tool has — so they can drift. This is what pins them together: every
 * parameter the advice names must exist in the shape it is paired with.
 */
test("every narrowing sentence names only parameters of its own paging shape", () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    // sentence, schema shape, response fields it may also name
    [LIST_PAGING_NARROWING, LIST_PAGING, ["nextStartPosition"]],
    [CURSOR_PAGING_NARROWING, cursorPaging(billPagingLimits("transactions")), ["nextPage"]],
    [CURSOR_PAGING_NARROWING, cursorPaging(billPagingLimits("cards")), ["nextPage"]],
    [
      cursorNarrowing({ format: false }),
      cursorPaging(billPagingLimits("customFieldValues"), { format: false }),
      ["nextPage"],
    ],
    [
      cursorNarrowing({ format: false }),
      cursorPaging(billPagingLimits("customFields"), { format: false }),
      ["nextPage"],
    ],
  ];
  for (const [sentence, shape, responseFields] of cases) {
    const named = [...sentence.matchAll(/`([A-Za-z]+)(?::[^`]*)?`/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `advice names no parameters: ${sentence}`);
    for (const knob of named) {
      assert.ok(
        knob in shape || responseFields.includes(knob),
        `advice names \`${knob}\`, which is not in its schema: ${sentence}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Filters (issue #29): what is asked of BILL, and what is checked of
 * the rows that come back.
 * ------------------------------------------------------------------ */

/**
 * The instance of the bug. `start_date` / `end_date` are not parameters BILL
 * reads, and it answers 200 with an unfiltered page rather than rejecting
 * them — so the only way to know they were wrong was to look at the dates.
 * BILL's own grammar is `filters=field:operator:value`, comma-joined, and it
 * rejects an unknown field or operator with a 400.
 */
test("a date range is asked of BILL in the grammar BILL actually reads", () => {
  assert.equal(
    billFilterParam({ startDate: "2026-05-01", endDate: "2026-06-30" }),
    "occurredTime:gte:2026-05-01,occurredTime:lte:2026-07-01",
  );
  assert.equal(
    billFilterParam({ budgetId: "bgt_uv3ogfaead47j90sf9v9k97ab8", syncStatus: "SYNCED" }),
    "budgetId:eq:bgt_uv3ogfaead47j90sf9v9k97ab8,syncStatus:eq:SYNCED",
  );
  // BILL has no `status` filter field (asking for one is a 400), so it
  // contributes no term and is enforced here instead.
  assert.equal(billFilterParam({ status: "DECLINED" }), undefined);
  assert.equal(billFilterParam({}), undefined);
});

/**
 * BILL's `lte` is midnight of the day named, so `lte:2026-06-26` excludes a
 * transaction at 2026-06-26T10:50 — the end of an inclusive range cannot be
 * said to BILL directly (a value with a time fails the `field:operator:value`
 * split on its colons). The tool asks for the day after and trims here.
 */
test("the last day of the range is in the range", () => {
  const onEndDate = { ...liveTransaction(1), occurredTime: "2026-06-26T10:50:44.000+00:00" };
  const dayAfterEnd = { ...liveTransaction(2), occurredTime: "2026-06-27T09:00:00.000+00:00" };
  const check = new FilterCheck({ startDate: "2026-06-01", endDate: "2026-06-26" });
  assert.deepEqual(check.keep([onEndDate, dayAfterEnd]), [onEndDate]);
  // The overhang is ours — we asked BILL for the wider bound — so it does not
  // read as BILL ignoring the filter.
  assert.match(check.report().endDate, /^server \+ client/);
});

/**
 * The check that would have caught #29: ask the rows, not the request. These
 * are the rows production actually returned for a May-June query before the
 * fix — the newest page, every row outside the range.
 */
test("rows outside the range asked for never reach the caller, and the result says so", () => {
  const unfiltered = [
    { ...liveTransaction(1), occurredTime: "2026-09-16T19:50:58.000+00:00" },
    { ...liveTransaction(2), occurredTime: "2026-08-02T13:52:22.000+00:00" },
    { ...liveTransaction(3), occurredTime: "2026-05-19T10:00:03.000+00:00" },
  ];
  const check = new FilterCheck({ startDate: "2026-05-01", endDate: "2026-06-30" });
  const kept = check.keep(unfiltered);

  assert.equal(kept.length, 1);
  assert.equal(String(kept[0].occurredTime).slice(0, 10), "2026-05-19");
  assert.equal(check.dropped, 2);
  // Not "filter: 2026-05-01" — that only echoes what was asked. This states
  // what happened, which is the whole difference.
  assert.match(check.report().endDate, /not being honored/);
  assert.match(check.report().endDate, /2 of 3 row\(s\) outside it/);
});

test("a filter BILL honors reads as server-side, with the rows to show for it", () => {
  const inRange = [1, 2, 3].map((i) => ({
    ...liveTransaction(i),
    occurredTime: `2026-05-0${i}T10:00:00.000+00:00`,
  }));
  const check = new FilterCheck({ startDate: "2026-05-01", endDate: "2026-06-30" });
  assert.equal(check.keep(inRange).length, 3);
  assert.equal(check.dropped, 0);
  assert.match(check.report().startDate, /^server — BILL filtered/);
  assert.match(check.report().endDate, /^server — BILL filtered/);
});

test("a filter BILL has no field for says it is applied here, not pretends to be a server filter", () => {
  const check = new FilterCheck({ status: "DECLINED" });
  const kept = check.keep(page(9));
  assert.equal(kept.length, 1); // liveTransaction(0) is the DECLINED one
  assert.match(check.report().status, /^client — BILL has no `status` filter/);
  assert.match(check.report().status, /8 of 9 row\(s\) dropped/);
});

/**
 * `budgetId` and `syncStatus` travel the same path, and were the same kind of
 * dead parameter (`budget_id`, `sync_status`). BILL takes both as filter
 * terms, and both have a witness on the row — BILL accepts either spelling of
 * a budget id, and states the accounting sync on a nested integration record.
 */
test("budgetId and syncStatus are checked against the row too", () => {
  const byId = new FilterCheck({ budgetId: "bdg_7f3a1c9e2d4b6a8c0e2f4a6b8c0d2e4f" });
  assert.equal(byId.keep(page(3)).length, 3);
  const byUuid = new FilterCheck({ budgetId: "bgt_other" });
  assert.equal(byUuid.keep(page(3)).length, 0);
  assert.match(byUuid.report().budgetId, /not being honored/);

  // Every 4th fixture row carries a nested "synced" record; the rest carry none.
  const synced = new FilterCheck({ syncStatus: "SYNCED" });
  assert.equal(synced.keep(page(8)).length, 2);
  const notSynced = new FilterCheck({ syncStatus: "NOT_SYNCED" });
  assert.equal(notSynced.keep(page(8)).length, 6);
});

test("a row carries the sync status the tool says it carries", () => {
  assert.equal(slimTransaction(liveTransaction(0)).syncStatus, "SYNCED");
  assert.equal(slimTransaction(liveTransaction(1)).syncStatus, undefined);
});

/** Registers the Divvy tools against a stub and hands back what was declared. */
function registeredTools(client: unknown) {
  const tools = new Map<
    string,
    { schema: Record<string, unknown>; handler: (args: Record<string, unknown>) => Promise<ToolResult> }
  >();
  // The v2 SDK registers with `registerTool(name, config, handler)` and takes a
  // Standard Schema object rather than a raw shape. The per-knob assertions
  // below read the shape, so unwrap it once here.
  const server = {
    registerTool: (
      name: string,
      config: { inputSchema?: { shape?: Record<string, unknown> } },
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => tools.set(name, { schema: config.inputSchema?.shape ?? {}, handler }),
  };
  registerDivvyTools(
    server as unknown as Parameters<typeof registerDivvyTools>[0],
    client as DivvyClient,
  );
  return tools;
}

const listResult = async (
  handler: (a: Record<string, unknown>) => Promise<ToolResult>,
  args: Record<string, unknown>,
) => JSON.parse((await handler(args)).content[0].text) as Record<string, unknown>;

/**
 * The structural pin. Every filter this tool advertises must be declared in
 * FILTER_SPECS — that is what makes it impossible to add one that is sent and
 * never checked, which is the shape #29 had.
 */
test("every filter the tool advertises is declared with how it is checked", () => {
  const { schema } = registeredTools({})!.get("divvy_list_transactions")!;
  const paging = new Set(Object.keys(cursorPaging(billPagingLimits("transactions"))));
  const advertised = Object.keys(schema).filter((k) => !paging.has(k));
  assert.ok(advertised.length > 0);
  for (const name of advertised) {
    assert.ok(
      name in FILTER_SPECS,
      `\`${name}\` is offered as a filter with no declaration of how a row is checked against it`,
    );
  }
  // And nothing is declared that the tool does not offer.
  for (const name of Object.keys(FILTER_SPECS)) {
    assert.ok(advertised.includes(name), `FILTER_SPECS declares \`${name}\`, which no tool offers`);
  }
});

test("the tool sends BILL one filter parameter and reports how each filter landed", async () => {
  const calls: Array<Record<string, string | undefined>> = [];
  const client = {
    listTransactions: async (p: Record<string, string | undefined>) => {
      calls.push(p);
      return {
        results: [1, 2, 3].map((i) => ({
          ...liveTransaction(i),
          occurredTime: `2026-05-0${i}T10:00:00.000+00:00`,
        })),
        nextPage: "cursor-2",
      };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, {
    startDate: "2026-05-01",
    endDate: "2026-06-30",
    pageSize: 3,
  });

  assert.equal(calls.length, 1, "the healthy path is one BILL call");
  assert.equal(calls[0].filters, "occurredTime:gte:2026-05-01,occurredTime:lte:2026-07-01");
  assert.equal(calls[0].start_date, undefined);
  assert.equal(result.returned, 3);
  assert.match(String((result.filtering as Record<string, string>).startDate), /^server/);
});

/**
 * If BILL stops honoring a filter, the rows are dropped here — and a page made
 * mostly of holes is refilled from the next BILL page rather than coming back
 * near-empty. Bounded: the walk only happens because rows were dropped.
 */
test("when BILL ignores a filter the page is refilled from the cursor, and says it was", async () => {
  let call = 0;
  const client = {
    listTransactions: async () => {
      call += 1;
      // BILL ignoring the range: page 1 is all outside it, page 2 all inside.
      const day = call === 1 ? "2026-09" : "2026-05";
      return {
        results: [1, 2, 3].map((i) => ({
          ...liveTransaction(i),
          occurredTime: `${day}-0${i}T10:00:00.000+00:00`,
        })),
        nextPage: `cursor-${call + 1}`,
      };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, {
    startDate: "2026-05-01",
    endDate: "2026-06-30",
    pageSize: "3",
  });

  assert.equal(call, 2);
  assert.equal(result.billPages, 2);
  assert.equal(result.returned, 3);
  for (const row of result.transactions as Array<{ date: string }>) {
    assert.ok(row.date >= "2026-05-01" && row.date <= "2026-06-30", `row outside range: ${row.date}`);
  }
  assert.match(String((result.filtering as Record<string, string>).endDate), /not being honored/);
  assert.equal(openCursor(String(result.nextPage)).cursor, "cursor-3");
});

test("the walk is bounded — an always-ignored filter stops rather than paging forever", async () => {
  let call = 0;
  const client = {
    listTransactions: async () => {
      call += 1;
      return {
        results: [{ ...liveTransaction(1), occurredTime: "2026-09-01T10:00:00.000+00:00" }],
        nextPage: `cursor-${call + 1}`,
      };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, { startDate: "2026-05-01", endDate: "2026-06-30" });
  assert.ok(call <= 10, `walked ${call} BILL pages`);
  assert.equal(result.returned, 0);
  // Zero rows, and the reason stated — not an empty answer with no explanation.
  assert.match(String((result.filtering as Record<string, string>).endDate), /not being honored/);
});

/* ------------------------------------------------------------------ *
 * Page size (issue #24): a knob the tool advertises must be one BILL
 * will honor — and `pageSize` is rows, not BILL pages.
 * ------------------------------------------------------------------ */

/**
 * The bug. `pageSize` was an unbounded string handed straight to BILL, whose
 * `max` on /v3/spend/transactions stops at 50, so a caller asking for a
 * fiscal year at `pageSize: "100"` got BILL's raw
 * `400 max: must be less than or equal to 50` — a limit the code knew (it had
 * its own `BILL_MAX_PAGE_SIZE = 50` a few lines away) and the schema did not.
 */
test("an ask bigger than one BILL page returns rows, by walking BILL's cursor", async () => {
  const asked: string[] = [];
  const client = {
    listTransactions: async (p: { pageSize?: string; page?: string }) => {
      const from = asked.length * 50;
      asked.push(String(p.pageSize));
      const n = Number(p.pageSize);
      return { results: page(n, from), nextPage: `cursor-${asked.length + 1}` };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, { pageSize: 100 });

  // Two BILL calls, neither of them asking for more than BILL allows.
  assert.deepEqual(asked, ["50", "50"]);
  assert.equal(result.returned, 100);
  assert.equal(result.billPages, 2);
  assert.equal(openCursor(String(result.nextPage)).cursor, "cursor-3");
});

/**
 * Asking BILL for exactly the rows still wanted is what makes `pageSize` mean
 * rows: the page ends on a BILL page boundary, so `returned` cannot exceed the
 * ask and the cursor handed back cannot skip rows this call already held.
 */
test("a partial page is asked of BILL as a partial page, so returned never exceeds pageSize", async () => {
  const asked: string[] = [];
  const client = {
    listTransactions: async (p: { pageSize?: string }) => {
      const from = asked.length * 50;
      asked.push(String(p.pageSize));
      return { results: page(Number(p.pageSize), from), nextPage: "more" };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, { pageSize: 70 });

  assert.deepEqual(asked, ["50", "20"]);
  assert.equal(result.returned, 70);
  assert.equal(result.billPages, 2);
  assert.equal(openCursor(String(result.nextPage)).cursor, "more");
});

/** The default is one BILL page's worth, so the everyday call stays one call. */
test("no pageSize means one BILL page, asked for at BILL's own maximum", async () => {
  const asked: string[] = [];
  const client = {
    listTransactions: async (p: { pageSize?: string }) => {
      asked.push(String(p.pageSize));
      return { results: page(50), nextPage: "more" };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, {});
  assert.deepEqual(asked, [String(BILL_MAX_PAGE_SIZE.transactions)]);
  assert.equal(result.returned, 50);
});

/**
 * The walk is bounded by what a tool result can carry as well as by the page
 * count: rows past the budget would be dropped by `packRows` anyway, so
 * fetching them is BILL calls spent on nothing.
 */
test("the walk stops once the rows in hand already fill the result budget", async () => {
  let calls = 0;
  const client = {
    listTransactions: async (p: { pageSize?: string }) => {
      const from = calls * 50;
      calls += 1;
      return { results: page(Number(p.pageSize), from), nextPage: `cursor-${calls + 1}` };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, { pageSize: 500 });

  assert.ok(calls < MAX_BILL_PAGES_PER_CALL, `spent ${calls} BILL calls on a budget-bound page`);
  assert.equal(result.truncatedBy, "size");
  assert.ok(compact(result).length <= MAX_RESULT_CHARS);
});

/**
 * The schema and BILL's limit are one fact, so the schema is generated from
 * the declaration rather than restating it. An ask past what the tool can
 * serve is refused by the schema, in a sentence naming BILL's page size —
 * before the call, not as a backend 400 after it.
 */
test("pageSize is bounded by what the tool can actually serve, and says where the bound comes from", () => {
  const { schema } = registeredTools({}).get("divvy_list_transactions")!;
  const limits = billPagingLimits("transactions");
  const pageSize = schema.pageSize as {
    safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } };
    description?: string;
  };

  assert.equal(pageSize.safeParse(limits.maxRows).success, true);
  const tooBig = pageSize.safeParse(limits.maxRows + 1);
  assert.equal(tooBig.success, false);
  assert.match(tooBig.error!.issues[0].message, new RegExp(String(limits.billPageSize)));
  // The 400 the issue reported is inside the bound now — it is served, not refused.
  assert.equal(pageSize.safeParse(100).success, true);
  // Callers (and BILL) spell it as a string; the schema coerces rather than refusing.
  assert.equal(pageSize.safeParse("100").success, true);
  assert.equal(pageSize.safeParse(0).success, false);
  assert.match(String(pageSize.description), new RegExp(`max ${limits.maxRows}`));
});

/**
 * The structural pin, and the regression test for the second bug this found:
 * `divvy_list_custom_field_values` spelled BILL's cursor and page size `page`
 * and `page_size`. BILL reads neither — it answers 200 and ignores them — so
 * that list returned its first 20 values whatever cursor it was given. Probed
 * live 2026-09-18: `?page_size=5` returns the same 20 rows as no parameter at
 * all, and `?page=<cursor>` returns page one again.
 *
 * Every paged BILL call now goes through one method, so the query parameters
 * are checked here once for all of them.
 */
test("every paged BILL call spells the cursor and page size the way BILL reads them", async () => {
  const urls: URL[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(new URL(String(url)));
    return { ok: true, json: async () => ({ results: [], nextPage: undefined }) } as Response;
  }) as typeof globalThis.fetch;
  try {
    const client = new DivvyClient("token");
    await client.listTransactions({ page: "c1", pageSize: "50", filters: "x:eq:y" });
    await client.listCards({ page: "c2", pageSize: "100" });
    await client.listBudgetsPage({ page: "c3", pageSize: "100" });
    await client.listCustomFieldValues("cf_1", { page: "c4", pageSize: "100" });
    await client.listCustomFields({ page: "c5", pageSize: "100" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(urls.length, 5);
  for (const [i, url] of urls.entries()) {
    assert.equal(url.searchParams.get(BILL_CURSOR_PARAM), `c${i + 1}`);
    assert.ok(url.searchParams.get(BILL_PAGE_SIZE_PARAM), `no ${BILL_PAGE_SIZE_PARAM} on ${url}`);
    // The names BILL answers 200 to and ignores.
    for (const dead of ["page", "page_size", "start_date", "budget_id"]) {
      assert.equal(url.searchParams.get(dead), null, `${url.pathname} still sends \`${dead}\``);
    }
  }
});

test("the custom-field values list pages — and its pageSize is bounded too", async () => {
  const asked: Array<{ page?: string; pageSize?: string }> = [];
  const client = {
    listCustomFieldValues: async (_id: string, p: { page?: string; pageSize?: string }) => {
      asked.push(p);
      return { results: [{ id: "v1", value: "NAP-100" }], nextPage: "next-cursor" };
    },
  };
  const { schema, handler } = registeredTools(client).get("divvy_list_custom_field_values")!;
  const result = await listResult(handler, { customFieldId: "cf_1", page: "cursor-2", pageSize: 1 });

  assert.deepEqual(asked, [{ page: "cursor-2", pageSize: "1" }]);
  assert.equal(openCursor(String(result.nextPage)).cursor, "next-cursor");
  assert.equal((result.values as unknown[]).length, 1);

  const limits = billPagingLimits("customFieldValues");
  const pageSize = schema.pageSize as { safeParse(v: unknown): { success: boolean } };
  assert.equal(pageSize.safeParse(limits.maxRows).success, true);
  assert.equal(pageSize.safeParse(limits.maxRows + 1).success, false);
  // This list has no `format`, and must not be given one it does not implement.
  assert.equal(schema.format, undefined);
});

/* ------------------------------------------------------------------ *
 * Custom field definitions (issue #46): the last BILL listing that
 * took no arguments at all.
 * ------------------------------------------------------------------ */

/** A BILL custom-field definition, in the shape /v3/spend/custom-fields returns. */
const customField = (i: number) => ({
  id: `VGFnVHlwZTozNzM2${String(i).padStart(2, "0")}`,
  uuid: `tty_tfg5dd0d99325fomhor9osjch${String(i).padStart(2, "0")}`,
  name: i === 0 ? "NAP CODES" : `Field ${i}`,
  type: "CUSTOM_SELECTOR",
  multiSelect: false,
  required: true,
  global: true,
  retired: false,
  createdTime: "2021-02-09T18:14:49.137+00:00",
});

/** BILL's custom-field list holding `total` definitions, served in pages. */
function customFieldClient(total: number, asked: Array<{ page?: string; pageSize?: string }> = []) {
  return {
    asked,
    listCustomFields: async (p: { page?: string; pageSize?: string } = {}) => {
      asked.push(p);
      const from = p.page ? Number(p.page) : 0;
      const n = Math.max(0, Math.min(Number(p.pageSize ?? 20), total - from));
      return {
        results: Array.from({ length: n }, (_, i) => customField(from + i)),
        nextPage: from + n < total ? String(from + n) : undefined,
      };
    },
  };
}

/**
 * The defect, in one assertion. The tool made one unparameterized call and
 * handed BILL's envelope back — so on books with more field definitions than
 * BILL's page, the extra ones were simply absent and the cursor BILL returned
 * had no parameter to come back in. Probed live 2026-09-23: `?max=1` on these
 * books returns one field and `nextPage: arrayconnection:0`, so BILL does page
 * this list; there were only two fields to page through, which is the only
 * reason nobody had lost a row yet.
 */
test("asking for the custom fields asks BILL for a page, and can follow its cursor", async () => {
  const client = customFieldClient(250);
  const { handler } = registeredTools(client).get("divvy_list_custom_fields")!;
  const first = await listResult(handler, {});

  // BILL's own page maximum for this list, not an unparameterized call.
  assert.deepEqual(client.asked, [
    { page: undefined, pageSize: String(BILL_MAX_PAGE_SIZE.customFields) },
  ]);
  assert.equal(first.returned, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.truncatedBy, "window");
  // BILL's own cursor, with the identity of the page it follows sealed onto it
  // — and the request below shows it is BILL's own cursor that goes back out.
  assert.equal(openCursor(String(first.nextPage)).cursor, "100");
  assert.match(String(first.note), /page: nextPage/);

  const second = await listResult(handler, { page: String(first.nextPage) });
  assert.equal(client.asked[1].page, "100");
  const firstIds = (first.customFields as Array<{ id: string }>).map((f) => f.id);
  const secondIds = (second.customFields as Array<{ id: string }>).map((f) => f.id);
  assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0, "page 2 repeats page 1");
});

test("a custom-field row keeps both ids and drops the flags that are false on every field", () => {
  const row = slimCustomField(customField(0));
  assert.equal(row.id, customField(0).id);
  assert.equal(row.uuid, customField(0).uuid, "the uuid the value/update tools take");
  assert.equal(row.name, "NAP CODES");
  assert.equal(row.type, "CUSTOM_SELECTOR");
  assert.equal(row.required, true);
  for (const gone of ["createdTime", "global", "multiSelect", "retired", "selectedBudgetUuids"]) {
    assert.ok(!(gone in row), `row still carries ${gone}`);
  }
  // A flag that IS true is kept — the omission is about constants, not content.
  assert.equal(slimCustomField({ ...customField(1), multiSelect: true }).multiSelect, true);
  assert.equal(slimCustomField({ ...customField(1), retired: true }).retired, true);
});

/**
 * #34's lesson on this listing: BILL re-sends the whole field definition on
 * every transaction row, so an empty definitions list while transactions name
 * NAP CODES and Notes is a blind source, not a company with no custom fields.
 */
test("an empty custom-field listing says which kind of nothing it found", async () => {
  const client = {
    listCustomFields: async () => ({ results: [], nextPage: undefined }),
    listTransactions: async () => ({ results: [liveTransaction(1)], nextPage: undefined }),
  };
  const { handler } = registeredTools(client).get("divvy_list_custom_fields")!;
  const result = await listResult(handler, {});
  const empty = result.empty as { meaning: string; checked: unknown[] };

  assert.equal(result.returned, 0);
  assert.equal(empty.meaning, "source-blind");
  assert.deepEqual(empty.checked, [
    { source: "recent transactions", found: 2, sample: ["NAP CODES", "Notes"] },
  ]);
});

test("a custom-field listing with no witness to consult claims nothing it did not check", async () => {
  const client = {
    listCustomFields: async () => ({ results: [], nextPage: undefined }),
    listTransactions: async () => {
      throw new Error("BILL 500");
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_custom_fields")!;
  const result = await listResult(handler, {});
  assert.equal((result.empty as { meaning: string }).meaning, "unverified");
});

test("the custom-field list walks BILL's cursor for an ask bigger than one page", async () => {
  const client = customFieldClient(250);
  const { handler } = registeredTools(client).get("divvy_list_custom_fields")!;
  const result = await listResult(handler, { pageSize: 120 });

  assert.deepEqual(
    client.asked.map((a) => a.pageSize),
    ["100", "20"],
  );
  assert.equal(result.returned, 120);
  assert.equal(result.billPages, 2);
});

test("the custom-field list's pageSize is bounded by what it can serve", () => {
  const { schema } = registeredTools(customFieldClient(2)).get("divvy_list_custom_fields")!;
  const limits = billPagingLimits("customFields");
  const pageSize = schema.pageSize as {
    safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } };
  };
  assert.equal(pageSize.safeParse(limits.maxRows).success, true);
  const tooBig = pageSize.safeParse(limits.maxRows + 1);
  assert.equal(tooBig.success, false);
  // BILL's own boundary, in the message: `max=101` is a 400 on this endpoint.
  assert.match(tooBig.error!.issues[0].message, new RegExp(String(limits.billPageSize)));
  assert.ok(schema.page, "no cursor parameter — the cursor BILL hands back is unfollowable");
  // This list returns BILL's definitions as they are; there is no row shape to
  // opt out of, so it must not advertise a `format` it does not implement.
  assert.equal(schema.format, undefined);
});

/**
 * The structural pin (issue #46's second goal). Three listings shipped with no
 * way to accept BILL's cursor — custom-field values (#24), cards (#43) and
 * custom-field definitions (#46) — and each was fixed as an instance because
 * nothing required a BILL listing to declare its paging the way FILTER_SPECS
 * requires a filter to declare how it is checked.
 *
 * This is that requirement. Every registered `divvy_list_*` tool must appear
 * either in DIVVY_LIST_TOOLS — and then really carry the shared cursor
 * vocabulary, bounded by that list's own maximum — or in UNPAGED_DIVVY_LISTS
 * with the reason it has nothing to page. A listing added tomorrow fails here
 * until someone says which it is.
 */
test("every Divvy listing declares its paging, or declares why it has none", () => {
  const tools = registeredTools({});
  const listings = [...tools.keys()].filter((name) => name.startsWith("divvy_list_"));
  assert.ok(listings.length >= 6, `only found ${listings.length} listings`);

  for (const name of listings) {
    const paged = (DIVVY_LIST_TOOLS as Record<string, BillListName>)[name];
    const exempt = UNPAGED_DIVVY_LISTS[name];
    assert.ok(
      (paged === undefined) !== (exempt === undefined),
      `\`${name}\` is a Divvy listing that is neither declared as a BILL paged list ` +
        `nor declared unpaged with a reason — the omission that shipped three times ` +
        `(#24, #43, #46)`,
    );
    if (!paged) {
      assert.ok(exempt.length > 20, `\`${name}\` is exempted with no real reason given`);
      continue;
    }

    const { schema } = tools.get(name)!;
    const limits = billPagingLimits(paged);
    assert.ok(schema.page, `\`${name}\` pages BILL's ${paged} but takes no \`page\` cursor`);
    const pageSize = schema.pageSize as {
      safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } };
    } | undefined;
    assert.ok(pageSize, `\`${name}\` takes no \`pageSize\``);
    // Bounded by this list's own maximum, not by some other endpoint's.
    assert.equal(pageSize!.safeParse(limits.maxRows).success, true, `\`${name}\` refuses its own max`);
    const tooBig = pageSize!.safeParse(limits.maxRows + 1);
    assert.equal(tooBig.success, false, `\`${name}\` accepts more rows than it can serve`);
    assert.match(tooBig.error!.issues[0].message, new RegExp(String(limits.billPageSize)));
  }

  // And nothing is declared for a tool that is not registered.
  for (const name of [...Object.keys(DIVVY_LIST_TOOLS), ...Object.keys(UNPAGED_DIVVY_LISTS)]) {
    assert.ok(listings.includes(name), `\`${name}\` is declared but no tool registers it`);
  }
});

/**
 * The pin's other half (issue #55). The test above checks what a paged listing
 * ACCEPTS; this checks what it RETURNS. `divvy_list_custom_field_values`
 * satisfied the input pin — declared, and genuinely paging — while still
 * handing BILL's envelope back, so a page past the end was a bare
 * `{"results":[]}` that could not say which kind of nothing it was. That is the
 * silence that hid a blind budget endpoint (#34), and nothing stopped the next
 * listing from shipping it.
 *
 * So every declared paged listing is driven against a BILL that returns no
 * rows at all, and must answer in the shared result vocabulary: `returned`,
 * `hasMore`, and an `empty` block — never BILL's own `results` array.
 */
test("every paged Divvy listing answers zero rows in the shared result vocabulary", async () => {
  // Every BILL method answers an empty page, whichever the tool calls — so a
  // listing added tomorrow needs no stub written for it to be checked here.
  const emptyBill = new Proxy(
    {},
    { get: () => async () => ({ results: [], nextPage: undefined }) },
  );
  const tools = registeredTools(emptyBill);

  for (const name of Object.keys(DIVVY_LIST_TOOLS)) {
    const { schema, handler } = tools.get(name)!;
    // Fill whatever the tool requires (a field id, say) with a placeholder.
    const args: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
      const f = field as { safeParse(v: unknown): { success: boolean } };
      if (!f.safeParse(undefined).success) args[key] = "x";
    }
    const res = await handler(args);
    assert.notEqual(res.isError, true, `\`${name}\` errored on an empty page: ${res.content[0].text}`);
    const result = JSON.parse(res.content[0].text) as Record<string, unknown>;

    assert.equal(
      result.returned,
      0,
      `\`${name}\` is declared a paged BILL list but does not state \`returned\` — ` +
        `it hands BILL's envelope back instead of the shared result vocabulary (#55)`,
    );
    assert.equal(result.hasMore, false, `\`${name}\` states no \`hasMore\` on an empty last page`);
    const empty = result.empty as { meaning?: string } | undefined;
    assert.ok(
      empty?.meaning,
      `\`${name}\` returned zero rows with no \`empty\` block, so "none exist" and ` +
        `"this source could not see them" read the same (#34, #55)`,
    );
    assert.equal(result.results, undefined, `\`${name}\` still carries BILL's raw \`results\``);
  }
});

/* ------------------------------------------------------------------ *
 * Custom field values (issue #55): paged, and now speaking the shared
 * result vocabulary.
 * ------------------------------------------------------------------ */

/** A transaction whose NAP CODES field names these values, spelled as BILL does. */
const txSelecting = (fieldId: string, labels: string[]) => ({
  ...liveTransaction(1),
  customFields: [
    {
      uuid: fieldId,
      customFieldId: fieldId,
      name: "NAP CODES",
      type: "SELECT",
      selectedValues: labels.map((l) => ({ value: l, label: l })),
    },
  ],
});

test("a custom-field value row keeps both ids and the label, and omits deleted: false", () => {
  assert.deepEqual(
    slimCustomFieldValue({
      id: "VGFnVmFsdWU6MzAwNTAw",
      uuid: "tvl_p5ag95f6p95gv5dhtl8a53ie",
      value: "Bank and Credit Card Fees ",
      deleted: false,
    }),
    { id: "VGFnVmFsdWU6MzAwNTAw", uuid: "tvl_p5ag95f6p95gv5dhtl8a53ie", value: "Bank and Credit Card Fees" },
  );
  assert.equal(slimCustomFieldValue({ id: "a", uuid: "b", value: "Old", deleted: true }).deleted, true);
});

test("a page of values speaks returned / hasMore / nextPage like every other listing", async () => {
  const client = {
    listCustomFieldValues: async () => ({
      results: [{ id: "v1", uuid: "tvl_1", value: "NAP-100", deleted: false }],
      nextPage: "next-cursor",
    }),
  };
  const { handler } = registeredTools(client).get("divvy_list_custom_field_values")!;
  const result = await listResult(handler, { customFieldId: "tty_nap", pageSize: 1 });

  assert.equal(result.entity, "CustomFieldValue");
  assert.equal(result.returned, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.truncatedBy, "window");
  assert.equal(openCursor(String(result.nextPage)).cursor, "next-cursor");
  // A value carries no amount, so there is no pageTotal to invent.
  assert.equal(result.pageTotal, undefined);
  assert.deepEqual(result.values, [{ id: "v1", uuid: "tvl_1", value: "NAP-100" }]);
});

test("an empty values listing while transactions select values on that field is source-blind", async () => {
  const client = {
    listCustomFieldValues: async () => ({ results: [], nextPage: undefined }),
    listTransactions: async () => ({
      results: [txSelecting("tty_nap", ["NAP-101"]), txSelecting("tty_nap", ["NAP-102", "NAP-101"])],
      nextPage: undefined,
    }),
  };
  const { handler } = registeredTools(client).get("divvy_list_custom_field_values")!;
  const result = await listResult(handler, { customFieldId: "tty_nap" });
  const empty = result.empty as { meaning: string; checked: unknown[] };

  assert.equal(result.returned, 0);
  assert.equal(empty.meaning, "source-blind");
  assert.deepEqual(empty.checked, [
    { source: "recent transactions", found: 2, sample: ["NAP-101", "NAP-102"] },
  ]);
});

test("values selected on a DIFFERENT field are no witness for this one", async () => {
  const client = {
    listCustomFieldValues: async () => ({ results: [], nextPage: undefined }),
    listTransactions: async () => ({
      results: [txSelecting("tty_nap", []), txSelecting("tty_other", ["Z-9"])],
      nextPage: undefined,
    }),
  };
  const { handler } = registeredTools(client).get("divvy_list_custom_field_values")!;
  const result = await listResult(handler, { customFieldId: "tty_nap" });
  // The field was sighted and nothing was selected on it: a checked nothing.
  assert.equal((result.empty as { meaning: string }).meaning, "none-found");
});

test("a field no recent transaction carries is unverified, not none-found", async () => {
  // Asked by an id the transactions do not spell — the witness never saw the
  // field, so `found: 0` would claim a check that did not happen.
  const client = {
    listCustomFieldValues: async () => ({ results: [], nextPage: undefined }),
    listTransactions: async () => ({ results: [txSelecting("tty_other", ["Z-9"])], nextPage: undefined }),
  };
  const { handler } = registeredTools(client).get("divvy_list_custom_field_values")!;
  const result = await listResult(handler, { customFieldId: "tty_nap" });
  assert.equal((result.empty as { meaning: string }).meaning, "unverified");
});

test("with no filters set, nothing is sent to BILL and nothing is claimed", async () => {
  const calls: Array<Record<string, string | undefined>> = [];
  const client = {
    listTransactions: async (p: Record<string, string | undefined>) => {
      calls.push(p);
      return { results: page(3), nextPage: undefined };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, {});
  assert.equal(calls[0].filters, undefined);
  assert.equal(result.filtering, undefined);
  assert.equal(result.returned, 3);
});

/* ------------------------------------------------------------------ *
 * Cards (issue #43): a list that took no arguments at all, so BILL's
 * own cursor was unfollowable and its default page was the whole
 * answer — 20 of 21 cards, silently.
 * ------------------------------------------------------------------ */

/**
 * A BILL card in the shape `/v3/spend/cards` returns. Every fifth one is
 * physical, which on these books means no name, no budget and no period —
 * the case a row must not carry as a column of nulls.
 */
function liveCard(i: number) {
  const physical = i % 5 === 4;
  return {
    id: `Q2FyZDoxNTU1MTgy${String(i).padStart(2, "0")}`,
    uuid: `crd_l9bmqukmfh2it8di10vheehh${String(i).padStart(2, "0")}`,
    userId: `VXNlcjoyMDI1NjU${i % 10}`,
    userUuid: `usr_piu3h89oop23nbu5r7hd8stc${String(i).padStart(2, "0")}`,
    ...(physical
      ? {}
      : {
          // BILL stores several names with a trailing space.
          name: `${i}U Tournaments `,
          budgetId: `QnVkZ2V0OjEwMDI5NDU${i % 7}`,
          budgetUuid: `bgt_7iodn4ddal3rvdf8kschfve3${String(i).padStart(2, "0")}`,
          validThru: "11/28",
          shareBudgetFunds: true,
          recurring: false,
          recurringLimit: null,
          currentPeriod: { limit: 0, spent: 5698.56 + i },
        }),
    lastFour: String(2000 + i),
    status: i % 9 === 0 ? "FROZEN" : "ACTIVATED",
    type: physical ? "PHYSICAL" : "VIRTUAL_VENDOR",
    createdTime: "2025-11-11T21:58:44.000+00:00",
    updatedTime: "2025-11-11T21:58:44.000+00:00",
  };
}

const cards = (n: number) => Array.from({ length: n }, (_, i) => liveCard(i));

/** A BILL card list holding `total` cards, served in pages of `p.pageSize`. */
function cardClient(total: number, asked: Array<{ page?: string; pageSize?: string }> = []) {
  return {
    asked,
    listCards: async (p: { page?: string; pageSize?: string } = {}) => {
      asked.push(p);
      const from = p.page ? Number(p.page) : 0;
      const n = Math.min(Number(p.pageSize ?? 20), total - from);
      return {
        results: cards(Math.max(0, n)).map((c, i) => ({ ...c, id: `card-${from + i}` })),
        nextPage: from + n < total ? String(from + n) : undefined,
      };
    },
  };
}

/**
 * The bug, in one assertion. The tool made an unparameterized call, so BILL
 * served its default page of 20 and the 21st card was unreachable: the cursor
 * it handed back (`arrayconnection:19`) had no parameter to come back in.
 */
test("asking for the cards lists all of them, in one BILL call", async () => {
  const client = cardClient(21);
  const { handler } = registeredTools(client).get("divvy_list_cards")!;
  const result = await listResult(handler, {});

  // BILL's own page maximum for this list, not its default of 20.
  assert.deepEqual(client.asked, [{ page: undefined, pageSize: String(BILL_MAX_PAGE_SIZE.cards) }]);
  assert.equal(result.returned, 21);
  assert.equal((result.cards as unknown[]).length, 21);
  // And it says so: nothing left behind, no cursor to chase.
  assert.equal(result.hasMore, false);
  assert.equal(result.nextPage, undefined);
});

test("a card listing that is short says it is short, and hands back a cursor that works", async () => {
  const client = cardClient(250);
  const { handler } = registeredTools(client).get("divvy_list_cards")!;
  const first = await listResult(handler, { pageSize: 100 });

  assert.equal(first.returned, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.truncatedBy, "window");
  // BILL's own cursor, with the identity of the page it follows sealed onto it
  // — and the request below shows it is BILL's own cursor that goes back out.
  assert.equal(openCursor(String(first.nextPage)).cursor, "100");
  assert.match(String(first.note), /page: nextPage/);

  // The cursor is followable — which is the whole of the defect.
  const second = await listResult(handler, { page: String(first.nextPage), pageSize: 100 });
  assert.equal(second.returned, 100);
  assert.equal(client.asked[1].page, "100");
  const firstIds = (first.cards as Array<{ id: string }>).map((c) => c.id);
  const secondIds = (second.cards as Array<{ id: string }>).map((c) => c.id);
  assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0, "page 2 repeats page 1");
});

test("an ask bigger than one BILL page walks its cursor, as the transaction list does", async () => {
  const client = cardClient(250);
  const { handler } = registeredTools(client).get("divvy_list_cards")!;
  const result = await listResult(handler, { pageSize: 120 });

  // Neither call asks BILL for more than its page maximum, and the second asks
  // for exactly the rows still wanted — so `pageSize` means rows here too.
  assert.deepEqual(
    client.asked.map((a) => a.pageSize),
    ["100", "20"],
  );
  assert.equal(result.returned, 120);
  assert.equal(result.billPages, 2);
});

test("a card row names the card, and omits what a physical card has none of", () => {
  const virtual = slimCard(liveCard(1));
  assert.equal(virtual.id, liveCard(1).id);
  assert.equal(virtual.uuid, liveCard(1).uuid);
  assert.equal(virtual.name, "1U Tournaments", "the trailing space BILL stores is trimmed");
  assert.equal(virtual.lastFour, "2001");
  assert.equal(virtual.type, "VIRTUAL_VENDOR");
  assert.equal(virtual.status, "ACTIVATED");
  // Both spellings, because that is what the transaction filter accepts.
  assert.equal(virtual.budgetId, liveCard(1).budgetId);
  assert.equal(virtual.budgetUuid, liveCard(1).budgetUuid);
  assert.equal(virtual.spent, 5699.56);
  // Envelope, dropped.
  for (const gone of ["createdTime", "updatedTime", "userId", "shareBudgetFunds", "recurring"]) {
    assert.equal(virtual[gone], undefined, `row still carries ${gone}`);
  }

  const physical = slimCard(liveCard(4));
  assert.equal(physical.type, "PHYSICAL");
  assert.equal(physical.lastFour, "2004", "lastFour is what names a card with no name");
  for (const absent of ["name", "budgetId", "budgetUuid", "validThru", "limit", "spent"]) {
    assert.ok(!(absent in physical), `physical card carries a null ${absent}`);
  }
});

test("rows are a fraction of BILL's card objects, and a long list stays inside the budget", async () => {
  const raw = cards(21);
  const rows = raw.map(slimCard);
  assert.ok(compact(rows).length < compact(raw).length / 1.5, "rows are not meaningfully smaller");

  const client = cardClient(1000);
  const { handler } = registeredTools(client).get("divvy_list_cards")!;
  const result = await listResult(handler, { pageSize: 1000 });
  assert.ok(compact(result).length <= MAX_RESULT_CHARS);
  assert.equal(result.truncatedBy, "size");
  // The budget cut this page short, so BILL's cursor points past the rows that
  // were dropped and is withheld — the same rule as the transaction list.
  assert.equal(result.nextPage, undefined);
  assert.match(String(result.note), /smaller `pageSize`/);
});

/**
 * The zero-row case, which is where #34's lesson applies to this list: every
 * transaction names the card that made it, so an empty card list while
 * transactions name cards is a blind source, not an empty wallet.
 */
test("an empty card listing says which kind of nothing it found", async () => {
  const client = {
    listCards: async () => ({ results: [], nextPage: undefined }),
    listTransactions: async () => ({
      results: [
        { ...liveTransaction(1), cardUuid: "crd_a", cardName: null, cardLastFour: "4417" },
        { ...liveTransaction(2), cardUuid: "crd_b", cardName: "Equipment " },
        { ...liveTransaction(3), cardUuid: "crd_b", cardName: "Equipment " },
      ],
      nextPage: undefined,
    }),
  };
  const { handler } = registeredTools(client).get("divvy_list_cards")!;
  const result = await listResult(handler, {});
  const empty = result.empty as { meaning: string; note: string; checked: unknown[] };

  assert.equal(result.returned, 0);
  assert.equal(empty.meaning, "source-blind");
  assert.deepEqual(empty.checked, [
    { source: "recent transactions", found: 2, sample: ["card ending 4417", "Equipment"] },
  ]);
});

test("a card listing with no witness to consult claims nothing it did not check", async () => {
  const client = {
    listCards: async () => ({ results: [], nextPage: undefined }),
    listTransactions: async () => {
      throw new Error("BILL 500");
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_cards")!;
  const result = await listResult(handler, {});
  assert.equal((result.empty as { meaning: string }).meaning, "unverified");
});

test("the card list's pageSize is bounded by what it can serve, and raw is opt-in", () => {
  const { schema } = registeredTools(cardClient(21)).get("divvy_list_cards")!;
  const limits = billPagingLimits("cards");
  const pageSize = schema.pageSize as {
    safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } };
  };
  assert.equal(pageSize.safeParse(limits.maxRows).success, true);
  const tooBig = pageSize.safeParse(limits.maxRows + 1);
  assert.equal(tooBig.success, false);
  assert.match(tooBig.error!.issues[0].message, new RegExp(String(limits.billPageSize)));
  assert.ok(schema.page, "no cursor parameter — the cursor BILL hands back is unfollowable");
  assert.ok(schema.format, "no way back to BILL's full card objects");
});

test("format: raw still returns BILL's own card objects", async () => {
  const client = cardClient(21);
  const { handler } = registeredTools(client).get("divvy_list_cards")!;
  const result = await listResult(handler, { format: "raw" });
  const results = result.results as Array<Record<string, unknown>>;
  assert.equal(results.length, 21);
  assert.equal(results[0].createdTime, "2025-11-11T21:58:44.000+00:00");
});
