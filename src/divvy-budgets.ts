/**
 * The Divvy (BILL Spend & Expense) budget listing, assembled from every source
 * that can name a budget — because BILL's own budget list cannot name them all.
 *
 * Measured against live books on 2026-09-17 (issue #34):
 * `GET /v3/spend/budgets` returns `{"results":[]}` while the same token's
 * transactions name ten budgets and its cards name eleven. It is not a missing
 * parameter and not a malformed request — every documented filter was tried:
 *
 *   (no filter)                              → 0
 *   retired:eq:false                         → 0
 *   retired:eq:true                          → 3 (all retired, all pre-2026)
 *   budgetIds:eq:<an active budget's uuid>   → 0   ← the documented id filter
 *   parentBudgetId / isBudgetGroup / name    → 0
 *   sort=name:asc, sort=spent:desc, max=100  → 0
 *
 * while `GET /v3/spend/budgets/<that same uuid>` returns the budget in full,
 * 200, with its name, limits and current-period spend. So the list endpoint is
 * blind to budgets this token can demonstrably read one at a time. Asking it
 * differently does not fix that; only asking something else does.
 *
 * Hence this module. A budget reference is discovered from the sources that do
 * name budgets — the budget list itself, cards, and recent transactions — and
 * each reference is then read back by id, which is BILL's own confirmation
 * that the budget exists. The result states per source what it contributed, so
 * a listing that is short because a source went blind says so rather than
 * passing off a partial answer as the whole (`src/empty-listing.ts` is the
 * same discipline for the zero-row case).
 */

import {
  BILL_MAX_PAGE_SIZE,
  walkBillPages,
  type BillListName,
  type BillPage,
  type WalkInput,
} from "./divvy-paging.js";
import { describeEmpty, type Witness } from "./empty-listing.js";

export type Raw = Record<string, unknown>;

/** What assembling a budget listing needs of a BILL client. */
export interface BudgetApi {
  listBudgetsPage(params: {
    filters?: string;
    page?: string;
    pageSize?: string;
  }): Promise<BillPage<Raw>>;
  getBudget(budgetId: string): Promise<Raw>;
  listCards(params?: { page?: string; pageSize?: string }): Promise<BillPage<Raw>>;
  listTransactions(params?: {
    filters?: string;
    page?: string;
    pageSize?: string;
  }): Promise<BillPage<Raw>>;
}

/** A budget named by some source: both spellings of the id, and a name if given. */
interface BudgetRef {
  id?: string;
  uuid?: string;
  name?: string;
}

/**
 * Bounds. Each one is a limit on how much BILL is asked for a listing that is
 * a lookup table, not a report — and each is stated in the result when it
 * bites, so a truncated listing never reads as a complete one.
 */
const MAX_CARD_PAGES = 5;
const MAX_TRANSACTION_PAGES = 4;
// Each walk asks BILL for its own page maximum per endpoint — read by
// `walkBillPages` from src/divvy-paging.ts, where it is declared once. These
// were three literals here, a fourth in the transaction tool and nothing at all
// in the schemas, which is how `pageSize: "100"` on a list BILL caps at 50
// became a raw backend 400 (issue #24).
const MAX_BUDGET_PAGES = 10;
/** How many discovered budgets are read back by id in one call. */
const MAX_READBACK = 100;
/** Concurrent read-backs. Small: this is a lookup table, not a load test. */
const READBACK_CONCURRENCY = 8;

const key = (ref: BudgetRef): string => ref.uuid ?? ref.id ?? "";

function addRef(into: Map<string, BudgetRef>, ref: BudgetRef): void {
  const k = key(ref);
  if (!k) return;
  const existing = into.get(k);
  if (existing) {
    into.set(k, { id: existing.id ?? ref.id, uuid: existing.uuid ?? ref.uuid, name: existing.name ?? ref.name });
  } else {
    into.set(k, ref);
  }
}

/**
 * Walks one source's BILL pages — through `walkBillPages`, the walker every
 * other BILL listing uses, not one of this module's own.
 *
 * This used to be a local loop. It stopped on `next === cursor`, which a
 * backend re-serving a page under a fresh cursor string walks straight past,
 * and the #33 witness reached it only because someone edited it by hand: the
 * rule lived in src/divvy-paging.ts and the loop lived here (issue #60). A
 * source's bound is `maxPages` full BILL pages, which is what `target` and
 * `maxPages` together say; a paging improvement made to the shared walker now
 * arrives here without anyone remembering this file exists.
 */
async function walk(
  list: BillListName,
  maxPages: number,
  fetch: WalkInput<Raw>["fetch"],
): Promise<{ rows: Raw[]; pages: number }> {
  const { rows, billPages } = await walkBillPages<Raw>({
    list,
    target: BILL_MAX_PAGE_SIZE[list] * maxPages,
    maxPages,
    fetch,
  });
  return { rows, pages: billPages };
}

/**
 * A source that can name budgets, declared as a pair like a filter
 * (`src/divvy-filters.ts`): what is asked of BILL, and what budget references
 * are read out of the answer. A source that fails is reported as failed rather
 * than quietly contributing nothing.
 */
interface DiscoverySource {
  name: string;
  /** What is asked of BILL, in the result's own words. */
  run(api: BudgetApi): Promise<{ refs: BudgetRef[]; scanned: number; pages: number }>;
  /** One sentence on what this source contributed to this result. */
  sentence(found: number, scanned: number, pages: number): string;
}

const CARDS: DiscoverySource = {
  name: "cards",
  async run(api) {
    const { rows, pages } = await walk("cards", MAX_CARD_PAGES, (p) => api.listCards(p));
    return {
      refs: rows.map((c) => ({ id: c.budgetId as string, uuid: c.budgetUuid as string })),
      scanned: rows.length,
      pages,
    };
  },
  sentence: (found, scanned, pages) =>
    `${scanned} card(s) scanned (${pages} page(s)) — ${found} budget(s) named.`,
};

const TRANSACTIONS: DiscoverySource = {
  name: "transactions",
  async run(api) {
    const { rows, pages } = await walk("transactions", MAX_TRANSACTION_PAGES, (p) =>
      api.listTransactions(p),
    );
    return {
      refs: rows.map((t) => ({
        id: t.budgetId as string,
        uuid: t.budgetUuid as string,
        name: t.budgetName as string,
      })),
      scanned: rows.length,
      pages,
    };
  },
  sentence: (found, scanned, pages) =>
    `${scanned} recent transaction(s) scanned (${pages} page(s), newest first) — ${found} budget(s) named.`,
};

const DISCOVERY_SOURCES = [CARDS, TRANSACTIONS];

/**
 * Every budget BILL's own list will give up.
 *
 * Asked twice — `retired:eq:false` and `retired:eq:true` — which between them
 * cover every budget, and which is not the same as asking with no filter: on
 * these books the unfiltered call returns nothing while `retired:eq:true`
 * returns three. An endpoint whose unfiltered answer is a strict subset of a
 * filtered one is exactly the kind of thing a listing should not paper over.
 */
async function fromBillList(
  api: BudgetApi,
): Promise<{ budgets: Raw[]; pages: number; perFilter: Record<string, number> }> {
  const budgets: Raw[] = [];
  const perFilter: Record<string, number> = {};
  let pages = 0;
  for (const filters of ["retired:eq:false", "retired:eq:true"]) {
    const walked = await walk("budgets", MAX_BUDGET_PAGES, (p) =>
      api.listBudgetsPage({ filters, ...p }),
    );
    pages += walked.pages;
    perFilter[filters] = walked.rows.length;
    budgets.push(...walked.rows);
  }
  return { budgets, pages, perFilter };
}

/**
 * Run one source and keep whichever came back — a value or the reason there
 * isn't one. A source that fails must not take the listing down with it: the
 * other sources still have something true to say, and the result says which
 * source went quiet.
 */
async function settle<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function trim(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
}

/**
 * A budget as a row: what it is called, both spellings of the id that
 * `divvy_list_transactions {"budgetId": …}` accepts, whether it is retired,
 * and this period's limit and spend. BILL's full object adds the recurrence
 * schedule, timezone, share/overspend policy and auto-add flags — settings,
 * not the answer to "which budget is this".
 */
export function slimBudget(b: Raw, seenOn: string[]): Record<string, unknown> {
  const period = (b.currentPeriod ?? {}) as Raw;
  const spent = (period.spent ?? {}) as Raw;
  const total = typeof spent.total === "number" ? spent.total : undefined;
  const limit =
    typeof period.limit === "number"
      ? period.limit
      : typeof b.recurringLimit === "number"
        ? (b.recurringLimit as number)
        : undefined;
  return trim({
    id: b.id,
    uuid: b.uuid,
    name: typeof b.name === "string" ? b.name.trim() : b.name,
    retired: b.retired === true ? true : undefined,
    group: b.budgetGroup === true ? true : undefined,
    limit,
    spent: total !== undefined ? round2(total) : undefined,
    period:
      period.startDate || period.endDate
        ? `${period.startDate ?? "?"}..${period.endDate ?? "?"}`
        : undefined,
    seenOn: seenOn.join(", "),
  });
}

/**
 * The budget listing: BILL's list, plus every budget named by a card or a
 * recent transaction and confirmed by reading it back by id.
 *
 * `sources` says what each one contributed. When the budget list returns fewer
 * budgets than the other sources name, that sentence says so in words — the
 * listing is then visibly assembled rather than silently short.
 */
export async function assembleBudgets(api: BudgetApi): Promise<Record<string, unknown>> {
  const sources: Record<string, string> = {};

  // The budget list and the discovery sources are independent asks, so they go
  // out together: BILL answers in roughly a second and a half, and three
  // walks in series is the difference between a tool call and a wait.
  const [listResult, ...discoveryResults] = await Promise.all([
    settle(() => fromBillList(api)),
    ...DISCOVERY_SOURCES.map((source) => settle(() => source.run(api))),
  ]);

  const listed = listResult.value?.budgets ?? [];
  const listPages = listResult.value?.pages ?? 0;
  const perFilter = listResult.value?.perFilter ?? {};
  const listFailed = listResult.error;

  const refs = new Map<string, BudgetRef>();
  const listedKeys = new Set<string>();
  const seenOn = new Map<string, string[]>();
  const note = (k: string, source: string) => {
    const list = seenOn.get(k) ?? [];
    if (!list.includes(source)) list.push(source);
    seenOn.set(k, list);
  };

  for (const b of listed) {
    const ref: BudgetRef = { id: b.id as string, uuid: b.uuid as string, name: b.name as string };
    addRef(refs, ref);
    listedKeys.add(key(ref));
    note(key(ref), "budget list");
  }

  const witnesses: Witness[] = [];
  DISCOVERY_SOURCES.forEach((source, i) => {
    const { value, error } = discoveryResults[i];
    if (!value) {
      // A source that failed contributed nothing, and says which of the two it
      // is: "no budgets on any card" and "the card list errored" are not the
      // same answer, and only one of them is a witness.
      sources[source.name] = `unavailable — ${error}`;
      return;
    }
    const distinct = new Map<string, BudgetRef>();
    for (const ref of value.refs) addRef(distinct, ref);
    for (const [k, ref] of distinct) {
      addRef(refs, ref);
      note(k, source.name);
    }
    sources[source.name] = source.sentence(distinct.size, value.scanned, value.pages);
    witnesses.push({
      source: source.name,
      found: distinct.size,
      sample: [...distinct.values()].map((r) => r.name ?? key(r)).filter(Boolean) as string[],
    });
  });

  // Everything named anywhere but the budget list has to be read back by id;
  // a 200 there is BILL confirming the budget exists, which is what makes
  // "the list is blind" a measurement rather than an accusation.
  const toRead = [...refs.entries()].filter(([k]) => !listedKeys.has(k)).slice(0, MAX_READBACK);
  const readBack = await mapWithConcurrency(toRead, READBACK_CONCURRENCY, async ([k, ref]) => {
    const id = ref.uuid ?? ref.id!;
    try {
      return { k, budget: await api.getBudget(id) };
    } catch (err) {
      return {
        k,
        budget: trim({ id: ref.id, uuid: ref.uuid, name: ref.name }) as Raw,
        unreadable: (err as Error).message,
      };
    }
  });

  const unreadable = readBack.filter((r) => r.unreadable).length;
  sources["budget list"] = listFailed
    ? `unavailable — ${listFailed}`
    : billListSentence(listed.length, toRead.length, perFilter, listPages);

  const rows = [
    ...listed.map((b) => slimBudget(b, seenOn.get(key({ id: b.id as string, uuid: b.uuid as string })) ?? [])),
    ...readBack.map((r) =>
      trim({
        ...slimBudget(r.budget, seenOn.get(r.k) ?? []),
        ...(r.unreadable ? { unreadable: r.unreadable } : {}),
      }),
    ),
  ].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

  const skipped = refs.size - listedKeys.size - toRead.length;

  return trim({
    entity: "Budget",
    returned: rows.length,
    sources,
    ...(skipped > 0
      ? {
          truncatedBy: "readback",
          note: `${skipped} more budget(s) were named but not read back — this call reads at most ${MAX_READBACK}.`,
        }
      : {}),
    ...(unreadable > 0
      ? { unreadable: `${unreadable} budget(s) were named elsewhere but could not be read by id.` }
      : {}),
    ...(rows.length === 0 ? { empty: describeEmpty(witnesses) } : {}),
    idNote:
      "`id` and `uuid` are both accepted by divvy_list_transactions {\"budgetId\": …}; `spent` and " +
      "`limit` are the current period only.",
    budgets: rows,
  });
}

function billListSentence(
  listedCount: number,
  discoveredCount: number,
  perFilter: Record<string, number>,
  pages: number,
): string {
  const asked = Object.entries(perFilter)
    .map(([f, n]) => `${f} → ${n}`)
    .join(", ");
  const base = `BILL's /v3/spend/budgets returned ${listedCount} budget(s) over ${pages} page(s) (${asked}).`;
  return discoveredCount > 0
    ? `${base} ${discoveredCount} further budget(s) are named by cards or transactions and were read back ` +
        "individually by id — its list does not return them (issue #34)."
    : `${base} Every budget named by cards or transactions was among them.`;
}
