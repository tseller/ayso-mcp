import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyClassToLines,
  mergeLinePatches,
  diffPaths,
  onlyClassRefChanged,
  type QboLine,
} from "./class-lines.js";
import {
  parseClassLedger,
  parseProfitAndLossByClass,
  findClassInSlot,
  buildClassUpdate,
  type QboClass,
} from "./qbo-client.js";
import { buildBudgetVsActuals, aggregateBudgetDetail, type QboBudget } from "./budget-actuals.js";
import { buildPurchaseLineUpdate, buildDepositLineUpdate } from "./tools/qbo-transactions.js";
import { buildClassTransactions } from "./tools/qbo-class-reports.js";
import { compact, MAX_RESULT_CHARS } from "./result-size.js";

/**
 * Fixtures below mirror the SHAPE of the live AYSO data — every field that a
 * real line was measured to carry — with invented names, ids and amounts. The
 * repository is public, so no real financial data lives here.
 */

/** A purchase line carrying everything a live purchase line was measured to carry. */
const purchaseLines = (): QboLine[] => [
  {
    Id: "1",
    Description: "Field paint — 12 cans",
    Amount: 214.5,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: "103", name: "Field Supplies" },
      BillableStatus: "NotBillable",
      TaxCodeRef: { value: "NON" },
      CustomerRef: { value: "77", name: "Region 2B145" },
    },
    CustomExtensions: [],
  },
  {
    Id: "2",
    Description: "Shipping",
    Amount: 18.25,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: "103", name: "Field Supplies" },
      BillableStatus: "NotBillable",
      TaxCodeRef: { value: "NON" },
    },
    CustomExtensions: [],
  },
];

const depositLines = (): QboLine[] => [
  {
    Id: "1",
    LineNum: 1,
    Description: "ACH credit — registration batch",
    Amount: 484.4,
    DetailType: "DepositLineDetail",
    DepositLineDetail: {
      Entity: { value: "37", name: "Registration Processor", type: "VENDOR" },
      AccountRef: { value: "25", name: "4005 Registration Fees" },
    },
    CustomExtensions: [],
  },
];

const journalLines = (): QboLine[] => [
  {
    Id: "0",
    Description: "Defer fall registration",
    Amount: 45,
    DetailType: "JournalEntryLineDetail",
    JournalEntryLineDetail: {
      PostingType: "Debit",
      Entity: { Type: "Customer", EntityRef: { value: "15", name: "Millbrae AYSO" } },
      AccountRef: { value: "25", name: "4005 Registration Fees" },
    },
    CustomExtensions: [],
  },
  {
    Id: "1",
    Description: "Defer fall registration",
    Amount: 45,
    DetailType: "JournalEntryLineDetail",
    JournalEntryLineDetail: {
      PostingType: "Credit",
      AccountRef: { value: "31", name: "2510 Deferred Registration Fees" },
    },
    CustomExtensions: [],
  },
];

// --- The headline guarantee: classing a transaction changes ONLY ClassRef ---

test("classing a purchase changes only ClassRef — every other line field survives", () => {
  const before = purchaseLines();
  const { lines, changed, skipped } = applyClassToLines("Purchase", before, "7");

  assert.equal(changed.length, 2);
  assert.equal(skipped.length, 0);
  assert.ok(onlyClassRefChanged(before, lines));
  assert.deepEqual(diffPaths(before, lines), [
    "0.AccountBasedExpenseLineDetail.ClassRef",
    "1.AccountBasedExpenseLineDetail.ClassRef",
  ]);

  // Spelled out, because this is the whole point of the module.
  const d = lines[0].AccountBasedExpenseLineDetail as Record<string, unknown>;
  assert.deepEqual(d.ClassRef, { value: "7" });
  assert.deepEqual(d.TaxCodeRef, { value: "NON" });
  assert.equal(d.BillableStatus, "NotBillable");
  assert.deepEqual(d.CustomerRef, { value: "77", name: "Region 2B145" });
  assert.equal(lines[0].Id, "1");
  assert.equal(lines[0].Description, "Field paint — 12 cans");
  assert.equal(lines[0].Amount, 214.5);
});

test("classing a deposit preserves Id, LineNum and the attributed Entity", () => {
  const before = depositLines();
  const { lines, changed } = applyClassToLines("Deposit", before, "7");

  assert.equal(changed.length, 1);
  assert.deepEqual(diffPaths(before, lines), ["0.DepositLineDetail.ClassRef"]);
  assert.equal(lines[0].LineNum, 1);
  assert.deepEqual((lines[0].DepositLineDetail as Record<string, unknown>).Entity, {
    value: "37",
    name: "Registration Processor",
    type: "VENDOR",
  });
});

test("classing a journal entry preserves PostingType and the nested Entity shape", () => {
  const before = journalLines();
  const { lines, changed } = applyClassToLines("JournalEntry", before, "9");

  assert.equal(changed.length, 2);
  assert.ok(onlyClassRefChanged(before, lines));
  const d = lines[0].JournalEntryLineDetail as Record<string, unknown>;
  assert.equal(d.PostingType, "Debit");
  assert.deepEqual(d.Entity, { Type: "Customer", EntityRef: { value: "15", name: "Millbrae AYSO" } });
});

test("diffPaths actually catches line-data loss — the old rebuild would not pass", () => {
  const before = purchaseLines();
  // What rebuilding lines from a 3-field schema produces: Id, TaxCodeRef,
  // BillableStatus and CustomerRef all gone. The guard must see that.
  const rebuilt: QboLine[] = before.map((l) => ({
    Amount: l.Amount,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: "103" },
      ClassRef: { value: "7" },
    },
    Description: l.Description,
  }));

  assert.equal(onlyClassRefChanged(before, rebuilt), false);
  const lost = diffPaths(before, rebuilt);
  for (const path of [
    "0.Id",
    "0.AccountBasedExpenseLineDetail.TaxCodeRef",
    "0.AccountBasedExpenseLineDetail.BillableStatus",
    "0.AccountBasedExpenseLineDetail.CustomerRef",
    "0.CustomExtensions",
  ]) {
    assert.ok(lost.includes(path), `expected diffPaths to flag ${path}`);
  }
});

test("lineIds restricts the change; untargeted lines are reported, not silently skipped", () => {
  const before = purchaseLines();
  const { lines, changed, skipped } = applyClassToLines("Purchase", before, "7", ["2"]);

  assert.deepEqual(changed.map((c) => c.lineId), ["2"]);
  assert.deepEqual(diffPaths(before, lines), ["1.AccountBasedExpenseLineDetail.ClassRef"]);
  assert.deepEqual(skipped, [{ lineId: "1", detailType: "AccountBasedExpenseLineDetail", reason: "not in lineIds" }]);
});

test("an unknown lineId is reported rather than quietly doing nothing", () => {
  const { changed, skipped } = applyClassToLines("Purchase", purchaseLines(), "7", ["99"]);
  assert.equal(changed.length, 0);
  assert.ok(skipped.some((s) => s.lineId === "99" && /no such line/.test(s.reason)));
});

test("clearing a class removes ClassRef and nothing else", () => {
  const tagged = applyClassToLines("Purchase", purchaseLines(), "7").lines;
  const { lines, changed } = applyClassToLines("Purchase", tagged, null);

  assert.equal(changed.length, 2);
  assert.deepEqual(changed[0], { lineId: "1", detailType: "AccountBasedExpenseLineDetail", from: "7", to: null });
  assert.deepEqual(diffPaths(tagged, lines), [
    "0.AccountBasedExpenseLineDetail.ClassRef",
    "1.AccountBasedExpenseLineDetail.ClassRef",
  ]);
  assert.deepEqual(lines, purchaseLines());
});

test("re-classing to the same class is a no-op, not a pointless write", () => {
  const tagged = applyClassToLines("Purchase", purchaseLines(), "7").lines;
  const { lines, changed, skipped } = applyClassToLines("Purchase", tagged, "7");

  assert.equal(changed.length, 0);
  assert.deepEqual(diffPaths(tagged, lines), []);
  assert.ok(skipped.every((s) => s.reason === "already set to this class"));
});

test("a line whose detail cannot carry a class is skipped with a reason", () => {
  const lines: QboLine[] = [
    { Id: "1", Amount: 10, DetailType: "DiscountLineDetail", DiscountLineDetail: { PercentBased: false } },
  ];
  const { changed, skipped } = applyClassToLines("Purchase", lines, "7");
  assert.equal(changed.length, 0);
  assert.match(skipped[0].reason, /cannot carry a class/);
});

// --- Merge-by-lineId on the update tools ---

test("merging by lineId changes the named field and preserves the rest", () => {
  const before = purchaseLines();
  const { lines, merged, unmatched } = mergeLinePatches("Purchase", before, [
    { lineId: "1", accountId: "205", classId: "7" },
  ]);

  assert.deepEqual(merged, ["1"]);
  assert.deepEqual(unmatched, []);
  const d = lines[0].AccountBasedExpenseLineDetail as Record<string, unknown>;
  assert.deepEqual(d.AccountRef, { value: "205" });
  assert.deepEqual(d.ClassRef, { value: "7" });
  assert.deepEqual(d.TaxCodeRef, { value: "NON" });
  assert.equal(d.BillableStatus, "NotBillable");
  assert.equal(lines[0].Amount, 214.5);
  // The line nobody mentioned is untouched.
  assert.deepEqual(lines[1], before[1]);
});

test("a full line replace is refused unless replaceAllLines is explicit", () => {
  const result = buildPurchaseLineUpdate(purchaseLines(), [{ amount: 10, accountId: "103" }], false);
  assert.ok("error" in result);
  assert.match(result.error, /replaceAllLines: true/);
  assert.match(result.error, /TaxCodeRef/);
});

test("mixing lineId and non-lineId lines is refused instead of half-merging", () => {
  const result = buildPurchaseLineUpdate(
    purchaseLines(),
    [{ lineId: "1", classId: "7" }, { amount: 10, accountId: "103" }],
    true,
  );
  assert.ok("error" in result);
  assert.match(result.error, /mixed line modes/);
});

test("an unmatched lineId aborts the whole update", () => {
  const result = buildPurchaseLineUpdate(purchaseLines(), [{ lineId: "42", classId: "7" }], false);
  assert.ok("error" in result);
  assert.match(result.error, /no line with id 42/);
  assert.match(result.error, /Nothing was changed/);
});

test("an explicit replace still requires amount and accountId on every line", () => {
  const result = buildPurchaseLineUpdate(purchaseLines(), [{ amount: 10 }], true);
  assert.ok("error" in result);
  assert.match(result.error, /missing amount or accountId/);
});

test("an explicit deposit replace carries class and entity onto the fresh lines", () => {
  const result = buildDepositLineUpdate(
    depositLines(),
    [{ amount: 100, accountId: "25", entityId: "37", classId: "7" }],
    true,
  );
  assert.ok(!("error" in result));
  const detail = (result as { lines: QboLine[] }).lines[0].DepositLineDetail as Record<string, unknown>;
  assert.deepEqual(detail.ClassRef, { value: "7" });
  assert.deepEqual(detail.Entity, { value: "37", type: "Vendor" });
});

// --- GeneralLedger class parsing ---

/**
 * Mirrors the live GeneralLedger shape: per-account Sections that carry their
 * label in `Header`/`Summary` rather than `ColData`, a leading "Beginning
 * Balance" Data row whose only populated cell is the first one, and real
 * transaction rows. Column order is QBO's own, not the requested order.
 */
const ledgerReport = {
  Header: {
    ReportName: "GeneralLedger",
    ReportBasis: "Accrual",
    StartPeriod: "2026-06-01",
    EndPeriod: "2026-06-30",
  },
  Columns: {
    Column: [
      { ColTitle: "Date", ColType: "Date" },
      { ColTitle: "Transaction Type", ColType: "String" },
      { ColTitle: "Num", ColType: "String" },
      { ColTitle: "Name", ColType: "String" },
      { ColTitle: "Class", ColType: "String" },
      { ColTitle: "Memo/Description", ColType: "String" },
      { ColTitle: "Account", ColType: "String" },
      { ColTitle: "Amount", ColType: "Money" },
    ],
  },
  Rows: {
    Row: [
      {
        type: "Section",
        Header: { ColData: [{ value: "1100 Chase Checking" }, {}, {}, {}, {}, {}, {}, {}] },
        Rows: {
          Row: [
            { type: "Data", ColData: [{ value: "Beginning Balance" }, {}, {}, {}, {}, {}, {}, {}] },
            {
              type: "Data",
              ColData: [
                { value: "2026-06-02" },
                { value: "Deposit" },
                { value: "" },
                { value: "Registration Processor" },
                { value: "Fall 2026" },
                { value: "ACH credit" },
                { value: "1100 Chase Checking" },
                { value: "1,200.00" },
              ],
            },
            {
              type: "Data",
              ColData: [
                { value: "2026-06-04" },
                { value: "Expense" },
                { value: "1042" },
                { value: "Field Supplies Co" },
                { value: "" },
                { value: "Field paint" },
                { value: "1100 Chase Checking" },
                { value: "-214.50" },
              ],
            },
          ],
        },
        Summary: { ColData: [{ value: "Total for 1100 Chase Checking" }, {}, {}, {}, {}, {}, {}, { value: "985.50" }] },
      },
      {
        type: "Section",
        Header: { ColData: [{ value: "2150 Divvy Credit Card Payable" }, {}, {}, {}, {}, {}, {}, {}] },
        Rows: {
          Row: [
            { type: "Data", ColData: [{ value: "Beginning Balance" }, {}, {}, {}, {}, {}, {}, {}] },
            {
              type: "Data",
              ColData: [
                { value: "2026-06-05" },
                { value: "Expense" },
                { value: "" },
                { value: "Referee Gear" },
                { value: "Spring 2026" },
                { value: "Divvy charge" },
                { value: "2150 Divvy Credit Card Payable" },
                { value: "-75.25" },
              ],
            },
          ],
        },
        Summary: { ColData: [{ value: "Total for 2150" }, {}, {}, {}, {}, {}, {}, { value: "-75.25" }] },
      },
    ],
  },
};

/** Same shape, but with the `id` attributes QBO hangs on the type and account cells. */
const ledgerReportWithIds = {
  ...ledgerReport,
  Rows: {
    Row: [
      {
        type: "Section",
        Header: { ColData: [{ value: "1100 Chase Checking" }] },
        Rows: {
          Row: [
            {
              type: "Data",
              ColData: [
                { value: "2026-06-04" },
                { value: "Expense", id: "1169" },
                { value: "" },
                { value: "Field Supplies Co" },
                { value: "" },
                { value: "Field paint" },
                { value: "1100 Chase Checking", id: "14" },
                { value: "-214.50" },
              ],
            },
          ],
        },
      },
    ],
  },
};

test("parseClassLedger returns transaction rows with their class, skipping section and balance rows", () => {
  const { transactions, total, basis } = parseClassLedger(ledgerReport);

  assert.equal(basis, "Accrual");
  assert.equal(transactions.length, 3);
  assert.deepEqual(
    transactions.map((t) => [t.date, t.type, t.className, t.amount]),
    [
      ["2026-06-02", "Deposit", "Fall 2026", 1200],
      ["2026-06-04", "Expense", "", -214.5],
      ["2026-06-05", "Expense", "Spring 2026", -75.25],
    ],
  );
  assert.equal(transactions[0].account, "1100 Chase Checking");
  assert.equal(transactions[1].docNumber, "1042");
  // The section summaries (985.50, -75.25) must NOT be counted into the total.
  assert.equal(total, 910.25);
});

test("parseClassLedger surfaces untagged rows as an empty class", () => {
  const { transactions } = parseClassLedger(ledgerReport);
  const untagged = transactions.filter((t) => !t.className);
  assert.equal(untagged.length, 1);
  assert.equal(untagged[0].memo, "Field paint");
});

test("parseClassLedger tolerates an empty report", () => {
  assert.deepEqual(parseClassLedger({}), {
    transactions: [],
    total: 0,
    basis: "",
    classFilterEcho: undefined,
  });
});

test("parseClassLedger reports QBO's class-filter echo", () => {
  const filtered = { ...ledgerReport, Header: { ...ledgerReport.Header, Class: "7" } };
  assert.equal(parseClassLedger(filtered).classFilterEcho, "7");
});

// --- P&L by class ---

const plByClass = {
  Header: { ReportName: "ProfitAndLoss", ReportBasis: "Accrual", SummarizeColumnsBy: "Classes" },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account", MetaData: [{ Name: "ColKey", Value: "account" }] },
      { ColTitle: "Fall 2026", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "7" }] },
      { ColTitle: "Not Specified", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "not_specified" }] },
      { ColTitle: "TOTAL", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
    ],
  },
  Rows: {
    Row: [
      {
        type: "Section",
        Rows: {
          Row: [
            {
              type: "Data",
              ColData: [
                { value: "4005 Registration Fees", id: "25" },
                { value: "1,200.00" },
                { value: "300.00" },
                { value: "1,500.00" },
              ],
            },
            {
              type: "Data",
              ColData: [
                { value: "6100 Field Supplies", id: "103" },
                { value: "214.50" },
                { value: "" },
                { value: "214.50" },
              ],
            },
          ],
        },
      },
    ],
  },
};

test("parseProfitAndLossByClass identifies columns by QBO's ColKey, not by name", () => {
  const parsed = parseProfitAndLossByClass(plByClass);

  assert.equal(parsed.basis, "Accrual");
  assert.equal(parsed.summarizedBy, "Classes");
  assert.deepEqual(
    parsed.columns.map((c) => [c.title, c.classId, c.isUntagged, c.isTotal]),
    [
      ["Fall 2026", "7", false, false],
      ["Not Specified", undefined, true, false],
      ["TOTAL", undefined, false, true],
    ],
  );
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].accountId, "25");
  assert.deepEqual(parsed.rows[0].byClass, {
    "Fall 2026": 1200,
    "Not Specified": 300,
    TOTAL: 1500,
  });
  // An empty cell is zero, not NaN.
  assert.equal(parsed.rows[1].byClass["Not Specified"], 0);
});

// --- Budget vs actuals ---

const budget: QboBudget = {
  Id: "1",
  Name: "FY2026-27",
  StartDate: "2026-07-01",
  EndDate: "2027-06-30",
  BudgetType: "ProfitAndLoss",
  BudgetEntryType: "Monthly",
  Active: true,
  BudgetDetail: [
    { BudgetDate: "2026-07-01", Amount: 1000, AccountRef: { value: "25", name: "4005 Registration Fees" }, ClassRef: { value: "7", name: "Fall 2026" } },
    { BudgetDate: "2026-08-01", Amount: 600, AccountRef: { value: "25", name: "4005 Registration Fees" }, ClassRef: { value: "7", name: "Fall 2026" } },
    { BudgetDate: "2026-07-01", Amount: 400, AccountRef: { value: "103", name: "6100 Field Supplies" }, ClassRef: { value: "7", name: "Fall 2026" } },
    // Outside the window under test — must not be counted.
    { BudgetDate: "2027-01-01", Amount: 9999, AccountRef: { value: "25", name: "4005 Registration Fees" }, ClassRef: { value: "8", name: "Spring 2027" } },
  ],
};

test("aggregateBudgetDetail sums per account × class inside the date window only", () => {
  const agg = aggregateBudgetDetail(budget, "2026-07-01", "2026-12-31");
  assert.equal(agg.size, 2);
  assert.equal(agg.get("25|7")?.amount, 1600);
  assert.equal(agg.get("103|7")?.amount, 400);
  assert.equal(agg.get("25|8"), undefined);
});

test("buildBudgetVsActuals joins budget to actuals on ids and keeps untagged actuals visible", () => {
  const actuals = parseProfitAndLossByClass(plByClass);
  const { rows, totals } = buildBudgetVsActuals(budget, actuals, {
    startDate: "2026-07-01",
    endDate: "2026-12-31",
  });

  const registrationFall = rows.find((r) => r.accountId === "25" && r.classId === "7");
  assert.deepEqual(registrationFall, {
    accountId: "25",
    account: "4005 Registration Fees",
    classId: "7",
    class: "Fall 2026",
    budget: 1600,
    actual: 1200,
    variance: 400,
    pctUsed: 75,
  });

  // The untagged actual is its own row with a null class — never folded away.
  const untagged = rows.find((r) => r.accountId === "25" && r.classId === null);
  assert.equal(untagged?.actual, 300);
  assert.equal(untagged?.budget, 0);
  assert.equal(untagged?.pctUsed, null);

  const supplies = rows.find((r) => r.accountId === "103");
  assert.equal(supplies?.budget, 400);
  assert.equal(supplies?.actual, 214.5);

  assert.equal(totals.budget, 2000);
  assert.equal(totals.actual, 1714.5);
  assert.equal(totals.variance, 285.5);
});

test("buildBudgetVsActuals never counts the TOTAL column as a class", () => {
  const actuals = parseProfitAndLossByClass(plByClass);
  const { rows } = buildBudgetVsActuals(budget, actuals);
  assert.ok(!rows.some((r) => r.class === "TOTAL"));
});

// --- Result size: a class ledger grows with its date range like any other report ---

test("buildClassTransactions pages a long range instead of returning an oversized payload", () => {
  // ~1,200 rows is a plausible fiscal year: one live month alone returned 56.
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    type: "Data",
    ColData: [
      { value: `2026-06-${String((i % 28) + 1).padStart(2, "0")}` },
      { value: "Expense", id: String(1000 + i) },
      { value: "" },
      { value: "A vendor with a reasonably long display name" },
      { value: "" },
      { value: "A memo of the length these actually run to in the real books" },
      { value: "1100 Chase Checking", id: "14" },
      { value: "-42.75" },
    ],
  }));
  const bigReport = {
    ...ledgerReport,
    Rows: { Row: [{ type: "Section", Header: { ColData: [{ value: "1100 Chase Checking" }] }, Rows: { Row: rows } }] },
  };

  const page = buildClassTransactions(bigReport, {
    startDate: "2025-07-01",
    endDate: "2026-06-30",
    requestedBasis: "Accrual",
  });

  assert.equal(page.rowCount, 1200);
  assert.ok((page.returned as number) < 1200, "a full fiscal year must not come back in one page");
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, page.returned);
  assert.ok(compact(page).length <= MAX_RESULT_CHARS, "a page must fit the tool-result budget");
  // The whole-range total is reported even though only a page of rows is sent.
  assert.equal(page.total, Math.round(1200 * -42.75 * 100) / 100);

  const second = buildClassTransactions(bigReport, {
    startDate: "2025-07-01",
    endDate: "2026-06-30",
    requestedBasis: "Accrual",
    offset: page.nextOffset as number,
  });
  assert.equal(second.offset, page.nextOffset);
  assert.ok((second.returned as number) > 0);
});

test("buildClassTransactions carries the QBO transaction id, so a row can be re-tagged directly", () => {
  const page = buildClassTransactions(ledgerReportWithIds, {
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    requestedBasis: "Accrual",
    untaggedOnly: true,
  });
  assert.equal(page.returned, 1);
  assert.deepEqual((page.rows as Array<Record<string, unknown>>)[0].id, "1169");
  assert.deepEqual((page.rows as Array<Record<string, unknown>>)[0].accountId, "14");
  assert.equal((page.rows as Array<Record<string, unknown>>)[0].class, null);
});

test("buildClassTransactions counts untagged across the whole period, not just the page", () => {
  const page = buildClassTransactions(ledgerReport, {
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    requestedBasis: "Accrual",
    untaggedOnly: true,
  });
  assert.equal(page.rowsInPeriod, 3);
  assert.equal(page.untaggedInPeriod, 1);
  assert.equal(page.rowCount, 1);
});

// --- Class slots: the same name under a different parent is a different class ---

const classList = (): QboClass[] => [
  { Id: "10", Name: "Core", FullyQualifiedName: "Core", Active: true, SubClass: false, SyncToken: "0" },
  { Id: "11", Name: "Select", FullyQualifiedName: "Select", Active: true, SubClass: false, SyncToken: "0" },
  { Id: "20", Name: "Fall 2026", FullyQualifiedName: "Fall 2026", Active: true, SubClass: false, SyncToken: "2" },
  {
    Id: "21",
    Name: "Spring 2027",
    FullyQualifiedName: "Select:Spring 2027",
    Active: true,
    SubClass: true,
    ParentRef: { value: "11" },
    SyncToken: "0",
  },
];

test("findClassInSlot treats a top-level class as distinct from a same-named sub-class", () => {
  assert.equal(findClassInSlot(classList(), "fall 2026")?.Id, "20");
  assert.equal(findClassInSlot(classList(), "Fall 2026", "10"), undefined);
  assert.equal(findClassInSlot(classList(), "Spring 2027", "11")?.Id, "21");
  assert.equal(findClassInSlot(classList(), "Spring 2027"), undefined);
});

test("buildClassUpdate nests a class under a parent and keeps its SyncToken", () => {
  const body = buildClassUpdate(classList()[2], { parentClassId: "10" }, classList());
  assert.equal(body.SubClass, true);
  assert.deepEqual(body.ParentRef, { value: "10" });
  assert.equal(body.SyncToken, "2");
  assert.equal(body.FullyQualifiedName, undefined);
});

test("buildClassUpdate moves a sub-class back to the top level", () => {
  const body = buildClassUpdate(classList()[3], { parentClassId: null }, classList());
  assert.equal(body.SubClass, false);
  assert.equal(body.ParentRef, undefined);
});

test("buildClassUpdate refuses a move that lands on an existing class", () => {
  const list = [...classList(), { Id: "22", Name: "Fall 2026", ParentRef: { value: "10" }, SubClass: true }];
  assert.throws(() => buildClassUpdate(list[2], { parentClassId: "10" }, list), /already sits at that name/);
});

test("buildClassUpdate refuses to nest a class under itself or its own sub-class", () => {
  assert.throws(() => buildClassUpdate(classList()[1], { parentClassId: "11" }, classList()), /under itself/);
  assert.throws(() => buildClassUpdate(classList()[1], { parentClassId: "21" }, classList()), /under itself/);
});
