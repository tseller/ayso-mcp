import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBudgets, slimBudget, type BudgetApi, type Raw } from "./divvy-budgets.js";
import { BILL_MAX_PAGE_SIZE, type BillPage } from "./divvy-paging.js";
import { describeEmpty } from "./empty-listing.js";
import { buildCursorList } from "./divvy-rows.js";
import { buildEntityList } from "./qbo-rows.js";
import { FILTER_SPECS } from "./divvy-filters.js";

/**
 * A stand-in for BILL with the behaviour measured on live books (issue #34):
 * the budget list returns only what `listed` holds — nothing at all without an
 * explicit `retired` filter — while every budget in `byId` can be read one at a
 * time, and cards and transactions name them freely.
 */
class FakeBill implements BudgetApi {
  readonly askedFilters: string[] = [];
  readonly readBack: string[] = [];

  constructor(
    private readonly opts: {
      listed?: Raw[];
      byId?: Record<string, Raw>;
      cards?: Raw[];
      transactions?: Raw[];
      failCards?: string;
      unreadable?: string[];
    },
  ) {}

  async listBudgetsPage({ filters }: { filters?: string }): Promise<BillPage<Raw>> {
    this.askedFilters.push(filters ?? "(none)");
    const listed = this.opts.listed ?? [];
    const retired = filters === "retired:eq:true";
    return { results: listed.filter((b) => Boolean(b.retired) === retired) };
  }

  async getBudget(id: string): Promise<Raw> {
    this.readBack.push(id);
    if (this.opts.unreadable?.includes(id)) throw new Error("Divvy API error 403 Forbidden");
    const found = this.opts.byId?.[id];
    if (!found) throw new Error(`Divvy API error 404 Not Found: ${id}`);
    return found;
  }

  async listCards(): Promise<BillPage<Raw>> {
    if (this.opts.failCards) throw new Error(this.opts.failCards);
    return { results: this.opts.cards ?? [] };
  }

  async listTransactions(): Promise<BillPage<Raw>> {
    return { results: this.opts.transactions ?? [] };
  }
}

const budget = (n: string, uuid: string, id: string, extra: Raw = {}): Raw => ({
  id,
  uuid,
  name: n,
  retired: false,
  budgetGroup: false,
  recurringInterval: "MONTHLY",
  timezone: "US/Pacific",
  autoAddUsers: true,
  receiptRequired: true,
  carryOver: false,
  shareFunds: "SHARE_MANUALLY",
  currentPeriod: {
    startDate: "2026-09-01",
    endDate: "2026-10-01",
    assigned: 0,
    spent: { cleared: 100.5, pending: 20.25, total: 120.75 },
  },
  ...extra,
});

test("a budget BILL's list does not return is listed anyway, read back by its own id", async () => {
  const capital = budget("Capital LiveScan Codes", "bgt_capital", "QnVkZ2V0Ojg2MDYzNQ==");
  const fleet = budget("Fleet US", "bgt_fleet", "QnVkZ2V0OjkwMDAwMA==");
  const bill = new FakeBill({
    listed: [],
    byId: { bgt_capital: capital, bgt_fleet: fleet },
    cards: [{ budgetId: capital.id, budgetUuid: capital.uuid, name: "Capital card" }],
    transactions: [
      { budgetId: capital.id, budgetUuid: capital.uuid, budgetName: capital.name },
      { budgetId: fleet.id, budgetUuid: fleet.uuid, budgetName: fleet.name },
    ],
  });

  const result = await assembleBudgets(bill);
  const rows = result.budgets as Record<string, unknown>[];

  assert.equal(result.returned, 2);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["Capital LiveScan Codes", "Fleet US"],
  );
  // The budget BILL's list is blind to is present, with both ids and a witness.
  assert.equal(rows[0].uuid, "bgt_capital");
  assert.equal(rows[0].seenOn, "cards, transactions");
  assert.equal(rows[1].seenOn, "transactions");
  // And the result says in words that the listing is assembled, not returned.
  assert.match(String((result.sources as Record<string, string>)["budget list"]), /does not return them/);
  // No `empty` block: there are rows, so there is nothing to explain away.
  assert.equal(result.empty, undefined);
});

test("a budget named by two sources is one row, not two", async () => {
  const b = budget("2026 Expo", "bgt_expo", "QnVkZ2V0OjEwMDA=");
  const bill = new FakeBill({
    listed: [],
    byId: { bgt_expo: b },
    cards: [
      { budgetId: b.id, budgetUuid: b.uuid },
      { budgetId: b.id, budgetUuid: b.uuid },
      { budgetId: b.id, budgetUuid: b.uuid },
    ],
    transactions: Array.from({ length: 12 }, () => ({
      budgetId: b.id,
      budgetUuid: b.uuid,
      budgetName: b.name,
    })),
  });

  const result = await assembleBudgets(bill);
  assert.equal(result.returned, 1);
  assert.equal(bill.readBack.length, 1, "one read-back per distinct budget");
});

test("the budget list is asked for both retired values, because the unfiltered call is not a superset", async () => {
  const active = budget("Google Voice", "bgt_voice", "QnVkZ2V0OjEx");
  const old = budget("ref spending", "bgt_ref", "QnVkZ2V0OjEyMg==", { retired: true });
  const bill = new FakeBill({ listed: [active, old], byId: {}, cards: [], transactions: [] });

  const result = await assembleBudgets(bill);

  assert.deepEqual(bill.askedFilters, ["retired:eq:false", "retired:eq:true"]);
  assert.equal(result.returned, 2);
  assert.equal(bill.readBack.length, 0, "nothing to read back when the list already has it");
  assert.match(
    String((result.sources as Record<string, string>)["budget list"]),
    /Every budget named by cards or transactions was among them/,
  );
});

test("a source that fails says so, instead of silently contributing nothing", async () => {
  const b = budget("Stack Sports", "bgt_stack", "QnVkZ2V0OjEz");
  const bill = new FakeBill({
    listed: [],
    byId: { bgt_stack: b },
    failCards: "Divvy API error 500 Internal Server Error",
    transactions: [{ budgetId: b.id, budgetUuid: b.uuid, budgetName: b.name }],
  });

  const result = await assembleBudgets(bill);
  const sources = result.sources as Record<string, string>;
  assert.match(sources.cards, /unavailable — Divvy API error 500/);
  assert.match(sources.transactions, /1 budget\(s\) named/);
  assert.equal(result.returned, 1);
});

test("a budget named elsewhere but unreadable by id is still reported, and counted as unreadable", async () => {
  const bill = new FakeBill({
    listed: [],
    byId: {},
    unreadable: ["bgt_secret"],
    cards: [],
    transactions: [{ budgetId: "QnVkZ2V0Ojk5", budgetUuid: "bgt_secret", budgetName: "Restricted" }],
  });

  const result = await assembleBudgets(bill);
  const rows = result.budgets as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Restricted");
  assert.match(String(rows[0].unreadable), /403/);
  assert.match(String(result.unreadable), /1 budget\(s\)/);
});

test("with nothing anywhere, the empty listing says every source was checked and saw none", async () => {
  const bill = new FakeBill({ listed: [], byId: {}, cards: [], transactions: [] });

  const result = await assembleBudgets(bill);
  const empty = result.empty as { meaning: string; note: string; checked: unknown[] };

  assert.equal(result.returned, 0);
  assert.equal(empty.meaning, "none-found");
  assert.match(empty.note, /cards, transactions/);
  assert.equal(empty.checked.length, 2);
});

test("every id a budget row states is an id divvy_list_transactions accepts", async () => {
  const b = budget("AYSO Region 2B145", "bgt_ayso", "QnVkZ2V0OjgxNzgxNQ==");
  const tx = { budgetId: b.id, budgetUuid: b.uuid, budgetName: b.name };
  const bill = new FakeBill({ listed: [], byId: { bgt_ayso: b }, cards: [], transactions: [tx] });

  const row = ((await assembleBudgets(bill)).budgets as Record<string, unknown>[])[0];

  // Both spellings round-trip into the transaction list's own budget filter —
  // which is the whole point of being able to list budgets at all.
  assert.ok(FILTER_SPECS.budgetId.matches(tx, String(row.id)));
  assert.ok(FILTER_SPECS.budgetId.matches(tx, String(row.uuid)));
});

/**
 * An endless BILL: every page is new rows and offers another cursor. What the
 * assembler asks of it is then exactly each source's own bound — the thing
 * issue #60 must not change when the local walker is replaced by the shared one.
 */
class EndlessBill implements BudgetApi {
  readonly asked: Record<string, Array<{ page?: string; pageSize?: string }>> = {
    budgets: [],
    cards: [],
    transactions: [],
  };
  private served = 0;

  private page(list: string, p: { page?: string; pageSize?: string }): BillPage<Raw> {
    this.asked[list].push({ page: p.page, pageSize: p.pageSize });
    const n = Number(p.pageSize);
    const results = Array.from({ length: n }, () => ({ id: `row${this.served++}` }));
    return { results, nextPage: `${list}-${this.served}` };
  }
  async listBudgetsPage(p: { filters?: string; page?: string; pageSize?: string }) {
    return this.page("budgets", p);
  }
  async getBudget(id: string): Promise<Raw> {
    return { id, name: id };
  }
  async listCards(p: { page?: string; pageSize?: string } = {}) {
    return this.page("cards", p);
  }
  async listTransactions(p: { page?: string; pageSize?: string } = {}) {
    return this.page("transactions", p);
  }
}

test("each source walks BILL through the shared walker, to exactly its own page bound", async () => {
  const bill = new EndlessBill();
  const result = await assembleBudgets(bill);
  // The bounds the local walker had: cards 5, transactions 4, the budget list 10 per filter.
  assert.equal(bill.asked.cards.length, 5);
  assert.equal(bill.asked.transactions.length, 4);
  assert.equal(bill.asked.budgets.length, 20);
  // Every request asks for the endpoint's own page maximum and follows BILL's cursor.
  assert.ok(bill.asked.cards.every((a) => a.pageSize === String(BILL_MAX_PAGE_SIZE.cards)));
  assert.ok(bill.asked.transactions.every((a) => a.pageSize === String(BILL_MAX_PAGE_SIZE.transactions)));
  assert.ok(bill.asked.budgets.every((a) => a.pageSize === String(BILL_MAX_PAGE_SIZE.budgets)));
  assert.equal(bill.asked.cards[0].page, undefined);
  assert.match(String(bill.asked.cards[1].page), /^cards-/);
  const sources = result.sources as Record<string, string>;
  assert.match(sources.cards, /500 card\(s\) scanned \(5 page\(s\)\)/);
  assert.match(sources.transactions, /200 recent transaction\(s\) scanned \(4 page\(s\)/);
  assert.match(sources["budget list"], /over 20 page\(s\)/);
});

test("a source whose cursor re-serves a page stops there, through the shared witness", async () => {
  let cardCalls = 0;
  const bill = new FakeBill({});
  bill.listCards = async () => {
    cardCalls += 1;
    // The same page under a fresh cursor string every time.
    return { results: [{ budgetId: "b1", budgetUuid: "bgt_1" }], nextPage: `fresh-${cardCalls}` };
  };
  const result = await assembleBudgets(bill);
  assert.equal(cardCalls, 2, `walked ${cardCalls} card pages on a stuck cursor`);
  assert.match((result.sources as Record<string, string>).cards, /1 card\(s\) scanned \(2 page\(s\)\)/);
});

test("a budget row keeps the name, the ids and this period's money, and drops the settings", () => {
  const row = slimBudget(
    budget("Capital LiveScan Codes", "bgt_capital", "QnVkZ2V0Ojg2MDYzNQ=="),
    ["cards"],
  );
  assert.deepEqual(row, {
    id: "QnVkZ2V0Ojg2MDYzNQ==",
    uuid: "bgt_capital",
    name: "Capital LiveScan Codes",
    spent: 120.75,
    period: "2026-09-01..2026-10-01",
    seenOn: "cards",
  });
});

test("an empty list states which kind of empty it is", () => {
  // Nothing checked: the honest answer is that nothing was checked.
  assert.equal(describeEmpty().meaning, "unverified");
  assert.match(describeEmpty().note, /not that none exist/);

  // A witness that saw none makes it a real answer.
  assert.equal(describeEmpty([{ source: "cards", found: 0 }]).meaning, "none-found");

  // A witness that saw rows makes it a blind answer — the #34 case.
  const blind = describeEmpty([
    { source: "transactions", found: 10, sample: ["AYSO Region 2B145", "Fleet US"] },
  ]);
  assert.equal(blind.meaning, "source-blind");
  assert.match(blind.note, /could not see them/);
  assert.deepEqual(blind.checked?.[0].sample, ["AYSO Region 2B145", "Fleet US"]);
});

test("no list tool returns a bare empty array — the shared builders always say why", () => {
  const cursor = buildCursorList({ entity: "Transaction", key: "transactions", rows: [] });
  const entity = buildEntityList({
    entity: "Purchase",
    key: "purchases",
    rows: [],
    startPosition: 1,
    maxResults: 100,
    rowCount: 0,
  });

  for (const result of [cursor, entity]) {
    assert.equal(result.returned, 0);
    const empty = result.empty as { meaning: string; note: string };
    assert.equal(empty.meaning, "unverified");
    assert.ok(empty.note.length > 0);
  }

  // And a page that has rows says nothing about emptiness.
  const nonEmpty = buildCursorList({
    entity: "Transaction",
    key: "transactions",
    rows: [{ id: "1", amount: 5 }],
  });
  assert.equal(nonEmpty.empty, undefined);
});
