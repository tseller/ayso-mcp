/**
 * How BILL pages a list — the spelling, the maximum, and the walk — declared
 * once, in one place.
 *
 * Three facts govern every BILL/Divvy listing, and they lived in five places
 * that agreed with each other nowhere: the query parameter carrying the cursor,
 * the one carrying the page size, and the maximum that second one accepts.
 *
 * Two bugs came out of that, and they are the same bug:
 *
 *  - `divvy_list_transactions` advertised `pageSize` as an unbounded string and
 *    handed it straight to BILL, so `pageSize: "100"` came back as BILL's raw
 *    `400 max: must be less than or equal to 50` (issue #24) — while the tool's
 *    own `BILL_MAX_PAGE_SIZE = 50` sat a few lines away, used for something
 *    else entirely. The limit was known to the code and not to the schema.
 *  - `divvy_list_custom_field_values` spelled those same two parameters `page`
 *    and `page_size`. BILL does not read either name, and answers 200 rather
 *    than rejecting them — so that tool could not page at all. Probed on live
 *    books 2026-09-18: `?page_size=5` returns the same 20 rows as no parameter,
 *    and `?page=<cursor>` returns the FIRST page again, forever.
 *
 * The second is issue #29's shape a fourth time — a parameter sent and assumed.
 * So the spelling is written down here once and every list goes through it; a
 * method can no longer invent a third name for BILL's cursor.
 *
 * Each endpoint's maximum is BILL's own answer, probed rather than assumed
 * (live books, 2026-09-18 — it validates `max`, so the 400 is the boundary):
 *
 *   /v3/spend/transactions            max <= 50    (51 is a 400)
 *   /v3/spend/cards                   max <= 100   (101 is a 400)
 *   /v3/spend/budgets                 max <= 100   (101 is a 400)
 *   /v3/spend/custom-fields/…/values  max <= 100   (101 is a 400)
 *   /v3/spend/custom-fields           max <= 100   (101 is a 400)
 *
 * A caller's `pageSize` is deliberately NOT that maximum. BILL's page is a
 * transport detail; `pageSize` is how many rows the caller wants back. An ask
 * larger than one BILL page is therefore served by walking `nextPage` here —
 * bounded by `MAX_BILL_PAGES_PER_CALL` and by the result-size budget — rather
 * than by a backend 400 the caller has to learn to loop around.
 *
 * Spelling the parameters once is half the fix (issue #33). The other half is
 * that a paging parameter, like a filter, is only real if the answer obeys it —
 * and BILL answers an unknown query parameter with 200 and a page, never a
 * refusal, so being ignored is invisible from the response unless something
 * looks. `FILTER_SPECS` (src/divvy-filters.ts) declares each filter as the term
 * sent and the same question asked of the rows that come back; `PAGING_SPECS`
 * and `PagingCheck` below are that treatment for paging, and `walkBillPages`
 * runs them on every page of every BILL listing rather than per tool. A rename
 * would have fixed the instance and left the next wrong name just as silent.
 */

import { createHash } from "node:crypto";

/** The query parameter BILL reads as the cursor. Not `page`. */
export const BILL_CURSOR_PARAM = "nextPage";

/** The query parameter BILL reads as the page size. Not `page_size`. */
export const BILL_PAGE_SIZE_PARAM = "max";

/** BILL's own maximum for `max`, per endpoint. Probed; see the file comment. */
export const BILL_MAX_PAGE_SIZE = {
  transactions: 50,
  cards: 100,
  budgets: 100,
  customFields: 100,
  customFieldValues: 100,
} as const;

export type BillListName = keyof typeof BILL_MAX_PAGE_SIZE;

/**
 * Which Divvy tool serves which BILL list.
 *
 * This exists because the same omission happened three times — a listing tool
 * shipped with no way to accept BILL's cursor — and each time it was fixed as
 * an instance:
 *
 *  - `divvy_list_custom_field_values` spelled the parameters `page`/`page_size`
 *    and could not page at all (issue #24);
 *  - `divvy_list_cards` took no arguments, so BILL's default page of 20 was the
 *    whole answer and the 21st card was unreachable (issue #43);
 *  - `divvy_list_custom_fields` took no arguments either — BILL hands it a
 *    cursor at `?max=1` and the tool had nowhere to put one (issue #46).
 *
 * Nothing pinned "a BILL listing declares the shared cursor shape", the way
 * `FILTER_SPECS` is pinned to the transaction tool's schema. This table is that
 * pin: `divvy-lists.test.ts` walks the registered tools and requires every
 * `divvy_list_*` to appear here (and to carry `page`/`pageSize` bounded by this
 * list's own maximum) or in `UNPAGED_DIVVY_LISTS` with a reason. A listing added
 * tomorrow cannot quietly ship without a cursor: the test fails until someone
 * says which of the two it is.
 */
export const DIVVY_LIST_TOOLS = {
  divvy_list_transactions: "transactions",
  divvy_list_cards: "cards",
  divvy_list_custom_fields: "customFields",
  divvy_list_custom_field_values: "customFieldValues",
} as const satisfies Record<string, BillListName>;

/**
 * The Divvy tools that read like a listing and take no cursor — each with the
 * reason it does not, because "this one has nothing to page" is a claim that
 * has now been wrong three times and must be argued rather than assumed.
 */
export const UNPAGED_DIVVY_LISTS: Record<string, string> = {
  divvy_list_budgets:
    "not one BILL list: BILL's budget endpoint is blind to most of these budgets, so the listing is assembled from several sources and read back by id (issue #34). Its own BILL calls page through `budgets`.",
  divvy_list_members:
    "GET /v3/spend/members answers 404 on these books — there is no list to page yet. Issue #38 owns it, and a cursor here would be a knob over a hole.",
  divvy_list_pending_action:
    "a triage view over the transaction list rather than a BILL endpoint: it walks `transactions` (through `walkBillPages`, like every BILL walk) and buckets what it finds, so the rows it returns are not one BILL page.",
};

/**
 * How many BILL pages one tool call may consume. A bound, not a target: a call
 * stops as soon as it has the rows asked for, so the ordinary ask — one page's
 * worth — is still one BILL call.
 */
export const MAX_BILL_PAGES_PER_CALL = 10;

/**
 * The paging limits a tool schema advertises for one BILL list: BILL's own page
 * size, and the largest row count this tool can honestly attempt in one call.
 * The schema reads them from here so the number in the description and the
 * number enforced are the same number.
 */
export const billPagingLimits = (list: BillListName) => ({
  billPageSize: BILL_MAX_PAGE_SIZE[list],
  maxRows: BILL_MAX_PAGE_SIZE[list] * MAX_BILL_PAGES_PER_CALL,
  maxPages: MAX_BILL_PAGES_PER_CALL,
});

/* ------------------------------------------------------------------ *
 * The witness: a paging parameter BILL did not read cannot be sent
 * unnoticed (issue #33).
 * ------------------------------------------------------------------ */

/** The paging arguments a Divvy cursor list accepts, as the caller spells them. */
export interface CursorPaging {
  page?: string;
  pageSize?: string;
}

/** What one BILL page offers as evidence about the knobs we turned. */
export interface PageWitness {
  /** The raw rows BILL returned for this page. */
  rows: unknown[];
  /** Fingerprint of those rows. */
  fingerprint: string;
  /** Fingerprint of the page this one's cursor was derived from, when known. */
  from?: string;
  /** Rows this request actually asked BILL for, as `max`. */
  asked?: string;
}

/**
 * One paging knob, declared as a pair — the twin of `FilterSpec`:
 * what BILL is asked, and the same question asked of the answer.
 */
export interface PagingSpec {
  /** BILL's own name for this knob on the v3 Spend endpoints. */
  readonly param: string;
  /** The value sent under that name. */
  send(value: string): string;
  /**
   * Was the knob read? `true` — this page shows it was, `false` — this page
   * shows it demonstrably was not, `undefined` — this page cannot witness it
   * either way, which is stated rather than rounded up to "honored".
   */
  honored(page: PageWitness): boolean | undefined;
}

export const PAGING_SPECS: Record<keyof CursorPaging, PagingSpec> = {
  page: {
    param: BILL_CURSOR_PARAM,
    // A sealed cursor travels to BILL as the plain cursor it wraps: the
    // fingerprint is ours, and BILL only ever sees a cursor it issued.
    send: (v) => openCursor(v).cursor,
    // A cursor is derived from a page, so a cursor that re-serves the rows it
    // was derived from has not advanced. An empty page witnesses nothing —
    // BILL does end a list with one — so it says so instead.
    honored: ({ rows, fingerprint, from }) =>
      from === undefined || rows.length === 0 ? undefined : fingerprint !== from,
  },
  pageSize: {
    param: BILL_PAGE_SIZE_PARAM,
    send: (v) => v,
    // One-sided on purpose: more rows than were asked for proves `max` was not
    // read, while fewer is just as likely to be the last page.
    honored: ({ rows, asked }) => {
      const max = Number(asked);
      return Number.isFinite(max) && max > 0 ? rows.length <= max : undefined;
    },
  },
};

/** The query parameters these paging arguments become. */
export function billPagingParams(paging: CursorPaging): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const knob of Object.keys(PAGING_SPECS) as Array<keyof CursorPaging>) {
    const value = paging[knob];
    out[PAGING_SPECS[knob].param] =
      value === undefined || value === "" ? undefined : PAGING_SPECS[knob].send(String(value));
  }
  return out;
}

/**
 * A page's identity, for the "did this cursor advance?" comparison. Taken over
 * BILL's own rows rather than our flattened ones, because what is compared is
 * what BILL serves for a cursor.
 */
export function pageFingerprint(rows: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

/** Separates BILL's cursor from the fingerprint sealed onto it. Not base64. */
const SEAL = "~";

/** BILL's cursor plus the identity of the page it came after. */
export function sealCursor(cursor: string, fingerprint: string): string {
  return `${cursor}${SEAL}${fingerprint}`;
}

/** The inverse. A cursor with no seal is returned as-is, carrying no witness. */
export function openCursor(value?: string): { cursor: string; fingerprint?: string } {
  if (!value) return { cursor: "" };
  const at = value.lastIndexOf(SEAL);
  if (at < 0) return { cursor: value };
  return { cursor: value.slice(0, at), fingerprint: value.slice(at + SEAL.length) };
}

/**
 * The cursor state machine for one tool call, and the witness that BILL read
 * the paging parameters it was sent.
 *
 * It is an accumulator rather than a function because one call can walk several
 * BILL pages (`walkBillPages` serves a row count bigger than BILL's page, or
 * refills a page client-side filtering emptied; `listPendingAction` walks to
 * the end). Every page is fingerprinted, so a cursor that loops back onto a
 * page already seen is caught wherever in the walk it happens — including the
 * A -> B -> A cycle a `next === cursor` string comparison walks straight past,
 * since a backend re-serving a page under a fresh cursor string satisfies it.
 */
export class PagingCheck {
  /** Fingerprints of every page seen in this call, plus the caller's cursor's. */
  private readonly seen = new Set<string>();
  /** The page the cursor about to be sent was derived from, when known. */
  private from?: string;
  /** BILL's cursor for the next request. */
  private cursor?: string;
  /** Whether the caller's own cursor carried a witness. */
  private readonly callerSealed: boolean;
  /** The most rows BILL put on one page here — what the `max` verdict counted. */
  private widest = 0;
  /** What that page had been asked for. */
  private widestAsked?: string;
  /** Rows on the page that repeated, when one did. */
  private loopedRows = 0;
  /** Cursor pages whose rows differed from the page they were derived from. */
  private advanced = 0;
  /** A cursor re-served a page already seen: the walk cannot go further. */
  looped = false;
  /** Per knob, whether BILL was shown to read it. `undefined` = unwitnessable. */
  private readonly verdicts = new Map<keyof CursorPaging, boolean | undefined>();

  constructor(private readonly asked: CursorPaging = {}) {
    const opened = openCursor(asked.page);
    if (opened.cursor) this.cursor = opened.cursor;
    this.callerSealed = Boolean(opened.fingerprint);
    if (opened.fingerprint) {
      this.from = opened.fingerprint;
      this.seen.add(opened.fingerprint);
    }
  }

  /** BILL's own cursor for the next request, seal already stripped. */
  get page(): string | undefined {
    return this.cursor;
  }

  /** Worst verdict wins: one page that proves a knob unread settles it. */
  private record(knob: keyof CursorPaging, verdict: boolean | undefined): void {
    if (this.verdicts.get(knob) === false) return;
    if (verdict === undefined && this.verdicts.get(knob) === true) return;
    this.verdicts.set(knob, verdict);
  }

  /**
   * One BILL page in; the rows to use out. A page whose cursor did not advance
   * is dropped — those rows are ones the caller already has, and handing them
   * back as a new page is the loop itself.
   *
   * `asked` is what this request put in `max`, which is what the page-size
   * verdict is measured against — the walk asks BILL for the rows still wanted,
   * so it is not always the caller's `pageSize`.
   */
  observe<T>(rows: T[] | undefined, nextPage?: string, asked?: string): T[] {
    const page = Array.isArray(rows) ? rows : [];
    const fingerprint = pageFingerprint(page);
    // `this.cursor` still holds the cursor that produced this page; nothing has
    // advanced it yet.
    const witness: PageWitness = { rows: page, fingerprint, from: this.from, asked };

    if (asked !== undefined && page.length >= this.widest) {
      this.widest = page.length;
      this.widestAsked = asked;
    }
    if (asked !== undefined) this.record("pageSize", PAGING_SPECS.pageSize.honored(witness));

    if (this.cursor !== undefined) {
      // A page repeating one seen earlier in this same walk is the same defect
      // one step further out, so it counts as not advancing.
      const repeat = page.length > 0 && this.seen.has(fingerprint);
      const verdict = repeat ? false : PAGING_SPECS.page.honored(witness);
      this.record("page", verdict);
      if (verdict === false) {
        this.looped = true;
        this.loopedRows = page.length;
        this.cursor = undefined;
        return [];
      }
      if (verdict === true) this.advanced += 1;
    }

    // An empty page is no page: it cannot be the thing a later cursor repeats,
    // and it is not the page a later cursor was derived from.
    if (page.length > 0) {
      this.seen.add(fingerprint);
      this.from = fingerprint;
    }
    this.cursor = nextPage || undefined;
    return page;
  }

  /** True while BILL has offered a cursor that has not been shown to loop. */
  get hasMore(): boolean {
    return Boolean(this.cursor);
  }

  /** The cursor to hand the caller: BILL's, sealed with this page's identity. */
  get nextPage(): string | undefined {
    if (!this.cursor || !this.from) return this.cursor;
    return sealCursor(this.cursor, this.from);
  }

  /**
   * Per knob, one sentence on how it was really enforced — or `undefined` when
   * the caller turned no knob and nothing was witnessed, so there is nothing to
   * report. The vocabulary is `FilterCheck.report()`'s: `server`, or a sentence
   * that starts `not honored`.
   */
  report(): Record<string, string> | undefined {
    const out: Record<string, string> = {};

    // A verdict of `false` is reported whether or not the caller turned the
    // knob — this tool turns it for them by default, and BILL overrunning a
    // `max` it was sent is the caller's business either way. `true` is reported
    // only where they asked, so an ordinary result is not padded with a
    // sentence about a parameter nobody passed.
    const sizeVerdict = this.verdicts.get("pageSize");
    if (sizeVerdict === false || (sizeVerdict === true && this.asked.pageSize !== undefined)) {
      out.pageSize =
        sizeVerdict === false
          ? `not honored — asked BILL for at most ${this.widestAsked} row(s) a page as \`${BILL_PAGE_SIZE_PARAM}\` ` +
            `and it returned ${this.widest}; the page-size parameter is being ignored`
          : `server — sent as \`${BILL_PAGE_SIZE_PARAM}\`; asked for ${this.asked.pageSize} row(s) a page and ` +
            `BILL returned at most ${this.widest}`;
    }

    if (this.looped) {
      out.page =
        `not honored — BILL re-served the same ${this.loopedRows} row(s) as a page already returned, so the ` +
        `\`${BILL_CURSOR_PARAM}\` cursor did not advance. Those rows were dropped rather than handed back as new ` +
        "ones, and the walk stops here rather than looping; the rest of this list cannot be reached by paging";
    } else if (this.asked.page && !this.callerSealed) {
      out.page =
        `server — sent as \`${BILL_CURSOR_PARAM}\`; this cursor was not issued by this tool, so whether it ` +
        "advanced could not be witnessed";
    } else if (this.advanced > 0) {
      out.page =
        `server — sent as \`${BILL_CURSOR_PARAM}\`; ${this.advanced} cursor page(s) fetched here, each carrying ` +
        "rows other than the page its cursor came from";
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }
}

/** One page as BILL returns it: rows, and a cursor when there are more. */
export interface BillPage<T> {
  results?: T[];
  nextPage?: string;
}

export interface WalkInput<T> {
  /** Which list — this is what fixes the page size asked of BILL. */
  list: BillListName;
  /** How many rows the caller wants back. */
  target: number;
  /**
   * The caller's own `pageSize`, when they passed one — what the `paging` block
   * reports a verdict on. `target` is the defaulted row count, so it cannot
   * tell a knob the caller turned from one this tool turned for them, and a
   * result should no more claim a verdict on an unasked knob than `filtering`
   * reports a filter nobody passed.
   */
  pageSizeAsked?: string;
  /** The caller's cursor, i.e. where to start. */
  page?: string;
  /** One BILL page. `pageSize` is already bounded to BILL's maximum. */
  fetch(params: { page?: string; pageSize: string }): Promise<BillPage<T>>;
  /**
   * Rows that survive the caller's filters (see `FilterCheck`). Dropping rows
   * is why a walk can be needed even for a single page's worth: a page made
   * mostly of holes is refilled from the next one rather than coming back
   * near-empty.
   */
  keep?(rows: T[]): T[];
  /**
   * Serialized size of one kept row, for stopping the walk once the rows in
   * hand already exceed what a tool result can carry. Optional because it is
   * the row *as the tool will emit it* that matters — a flattened Divvy row is
   * a sixth of the raw object — so only the caller can measure it.
   */
  measure?(row: T): number;
  /** Character budget for the accumulated rows. */
  budgetChars?: number;
  /**
   * How many BILL pages this walk may consume. Defaults to
   * `MAX_BILL_PAGES_PER_CALL`, the bound for a tool call that answers one
   * caller's page. A walk that is not serving a caller's page — the budget
   * assembler's per-source scans, the pending-action triage over the whole
   * transaction list — states its own bound here rather than hand-rolling a
   * loop to get one, which is how those two walkers came to miss the #33
   * witness until it was added to each by hand (issue #60).
   */
  maxPages?: number;
}

export interface Walked<T> {
  /** Kept rows, in BILL's order, at most `target` of them. */
  rows: T[];
  /**
   * The cursor for the page after this one, when BILL gave one and it has not
   * been shown to loop — BILL's own cursor with the identity of the page it
   * follows sealed onto it, so the next call can witness that it advanced.
   */
  nextPage?: string;
  /** BILL pages consumed for this one result. */
  billPages: number;
  /** BILL's last page verbatim, for the tools that hand its envelope back. */
  last: BillPage<T>;
  /** Per paging knob, how it was really enforced (see `PagingCheck.report`). */
  paging?: Record<string, string>;
  /** BILL's cursor re-served a page already returned, so the walk stopped. */
  cursorStalled: boolean;
}

/**
 * Walk BILL's cursor until there are `target` rows, BILL runs out, or a bound
 * bites.
 *
 * Each call asks BILL for exactly the rows still wanted (never more than its
 * page maximum), so the accumulated rows end on a BILL page boundary and the
 * cursor handed back is exactly right. That is what lets `pageSize` mean rows
 * rather than BILL pages: `returned` can no longer exceed what was asked for,
 * and following `nextPage` cannot skip rows this call already had in hand.
 *
 * The cursor is also *witnessed* here, for every listing at once: `PagingCheck`
 * fingerprints each page BILL serves and compares it with the page the cursor
 * came from, so a cursor that does not advance stops the walk and is reported
 * instead of looping (issue #33). Before this, a backend re-serving page one
 * forever cost `MAX_BILL_PAGES_PER_CALL` requests and handed the same rows back
 * ten times over as though they were ten pages.
 */
export async function walkBillPages<T>({
  list,
  target,
  pageSizeAsked,
  page,
  fetch,
  keep,
  measure,
  budgetChars,
  maxPages = MAX_BILL_PAGES_PER_CALL,
}: WalkInput<T>): Promise<Walked<T>> {
  const billPageSize = BILL_MAX_PAGE_SIZE[list];
  const wanted = Math.max(1, Math.floor(target));
  // The caller's cursor may carry the seal this tool put on it; `paging.page` is
  // BILL's own cursor, which is all that goes on the wire.
  const paging = new PagingCheck({ page, pageSize: pageSizeAsked });

  let billPages = 0;
  let rows: T[] = [];
  let chars = 0;
  let last: BillPage<T> = {};

  do {
    const ask = Math.min(wanted - rows.length, billPageSize);
    last = await fetch({ page: paging.page, pageSize: String(ask) });
    billPages += 1;
    // Whatever BILL served is judged before it is used: a page the cursor
    // should not have produced contributes no rows.
    const got = paging.observe(last.results, last.nextPage, String(ask));
    const kept = keep ? keep(got) : got;
    rows = rows.concat(kept);
    if (measure) for (const row of kept) chars += measure(row) + 1;
  } while (
    paging.hasMore &&
    rows.length < wanted &&
    billPages < maxPages &&
    (budgetChars === undefined || chars < budgetChars)
  );

  return {
    rows,
    nextPage: paging.nextPage,
    billPages,
    last,
    paging: paging.report(),
    cursorStalled: paging.looped,
  };
}
