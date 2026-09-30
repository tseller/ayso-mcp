/**
 * Flattened rows for the Divvy (BILL Spend & Expense) list tools, and the
 * cursor-paged envelope they come back in.
 *
 * BILL returns the full transaction object on a list, and most of it is
 * envelope rather than information: on live books the default call at BILL's
 * own maximum page size (50) is 93,704 characters — over twice the
 * tool-result budget, so the everyday call simply failed. The flattened row
 * existed, behind `compact: true`; the same 50 transactions are 14,973
 * characters that way. Nothing was missing but the default.
 *
 * A row keeps what a treasurer reads and what a follow-up call needs: the
 * date, who spent it, where, how much, whether the receipt and the sync are
 * done, and both ids (`id` for a deep link or `divvy_get_transaction`, `uuid`
 * for the receipt/custom-field writes). Full fidelity is one
 * `divvy_get_transaction` away, or `format: "raw"` for a whole page of it.
 *
 * Pure, so the row shape and the paging/size behaviour can be tested against a
 * large page without going near BILL.
 */

import { rowSyncStatus } from "./divvy-filters.js";
import { describeEmpty, type Witness } from "./empty-listing.js";
import { packRows } from "./result-size.js";

type Tx = Record<string, unknown>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One transaction as a row. The filled custom fields (NAP CODES, Notes)
 * collapse from BILL's array of field objects to a `name: value` map — the
 * definitions are `divvy_list_custom_fields`, not something to repeat on every
 * row — and an empty field is dropped rather than carried as `""`.
 */
export function slimTransaction(tx: Tx): Record<string, unknown> {
  const customFields = Array.isArray(tx.customFields)
    ? (tx.customFields as Array<{ name?: string; selectedValues?: unknown[]; note?: string }>)
    : [];
  const fields: Record<string, string> = {};
  for (const f of customFields) {
    if (!f.name) continue;
    const selected = selectedValueLabels(f);
    const value = selected.length > 0 ? selected.join(", ") : (f.note ?? "").trim();
    if (value) fields[f.name] = value;
  }
  return {
    id: tx.id,
    uuid: tx.uuid,
    date: String(tx.occurredTime ?? "").slice(0, 10),
    status: tx.status,
    user: tx.userName,
    merchant: tx.merchantName,
    amount: tx.amount,
    receiptStatus: tx.receiptStatus,
    // BILL states the accounting sync on a nested integration record, not a
    // top-level `syncStatus` — reading the top-level name meant the row this
    // tool advertises as carrying a sync status never carried one.
    syncStatus: rowSyncStatus(tx),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

/**
 * The labels of the values selected on one of a transaction's custom fields.
 * BILL has sent these both as bare strings and as `{value, label}` objects, so
 * both are read. Shared by the transaction row and by the witness for
 * `divvy_list_custom_field_values`, so the two cannot read a value differently.
 */
export function selectedValueLabels(field: { selectedValues?: unknown }): string[] {
  const selected = Array.isArray(field.selectedValues) ? field.selectedValues : [];
  return selected
    .map((v) => {
      if (typeof v === "string") return v;
      const o = (v ?? {}) as { value?: unknown; label?: unknown; name?: unknown };
      return String(o.value ?? o.label ?? o.name ?? "");
    })
    .filter(Boolean);
}

/**
 * One option value of a custom field (a NAP code) as a row.
 *
 * BILL's value object is already small — both ids, the label, a `deleted` flag
 * — so the row is mostly the object itself; what it changes is that `deleted`
 * is carried only when it is true, the same rule the card and field rows follow
 * for a column that is `false` on every row. Both ids stay: the `uuid` is what
 * `divvy_update_transaction_custom_fields` takes in `selectedValues`.
 */
export function slimCustomFieldValue(value: Tx): Record<string, unknown> {
  const label = typeof value.value === "string" ? value.value.trim() : value.value;
  return {
    id: value.id,
    uuid: value.uuid,
    value: label,
    ...(value.deleted ? { deleted: true } : {}),
  };
}

/**
 * One card as a row.
 *
 * The card list handed BILL's objects back whole — 9,532 characters for the 20
 * cards it returned (issue #43) — and most of that is bookkeeping: the
 * created/updated timestamps, the numeric `userId` beside the `usr_…` uuid,
 * `shareBudgetFunds`, `recurring`, `recurringLimit`. A row keeps what names
 * the card and what a follow-up call needs: both ids, who holds it, the budget
 * it draws on in both spellings `divvy_list_transactions {"budgetId": …}`
 * accepts, and the current period's limit and spend.
 *
 * A physical card carries no `name`, no budget and no period on these books,
 * so those keys are omitted rather than carried as `null` — `lastFour` is what
 * names such a card. Card names are trimmed: BILL stores several with a
 * trailing space ("10U Tournaments ").
 */
export function slimCard(card: Tx): Record<string, unknown> {
  const period = (card.currentPeriod ?? {}) as { limit?: unknown; spent?: unknown };
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const name = typeof card.name === "string" ? card.name.trim() : "";
  return {
    id: card.id,
    uuid: card.uuid,
    ...(name ? { name } : {}),
    lastFour: card.lastFour,
    type: card.type,
    status: card.status,
    ...(card.budgetId || card.budgetUuid
      ? { budgetId: card.budgetId, budgetUuid: card.budgetUuid }
      : {}),
    userUuid: card.userUuid,
    ...(card.validThru ? { validThru: card.validThru } : {}),
    ...(num(period.limit) !== undefined ? { limit: num(period.limit) } : {}),
    ...(num(period.spent) !== undefined ? { spent: num(period.spent) } : {}),
  };
}

/**
 * One custom-field *definition* as a row.
 *
 * BILL sends each definition with its budget-scoping arrays (`selectedBudgetIds`
 * / `selectedBudgetUuids` / `requiredBudgetIds` / `requiredBudgetUuids`, empty on
 * every field on these books), a `createdTime` from 2021 and a `global` flag
 * that only restates the empty scoping. A row keeps what names the field and
 * what a follow-up call needs: both ids — `divvy_list_custom_field_values` and
 * `divvy_update_transaction_custom_fields` are driven from them — the name, the
 * type, and whether it is required.
 *
 * The flags that are false on every field are omitted rather than carried as a
 * column of `false`, the same rule the card row and the QBO `active` column
 * follow; a scoping array is carried only when it actually scopes something.
 */
export function slimCustomField(field: Tx): Record<string, unknown> {
  const scoped = (v: unknown) => (Array.isArray(v) && v.length > 0 ? v : undefined);
  const name = typeof field.name === "string" ? field.name.trim() : field.name;
  return {
    id: field.id,
    uuid: field.uuid,
    name,
    type: field.type,
    required: field.required,
    ...(field.multiSelect ? { multiSelect: true } : {}),
    ...(field.allowCustomValues ? { allowCustomValues: true } : {}),
    ...(field.retired ? { retired: true } : {}),
    ...(scoped(field.selectedBudgetUuids)
      ? { selectedBudgetUuids: field.selectedBudgetUuids }
      : {}),
    ...(scoped(field.requiredBudgetUuids)
      ? { requiredBudgetUuids: field.requiredBudgetUuids }
      : {}),
  };
}

export interface CursorListInput {
  /** Record type, e.g. "Transaction". */
  entity: string;
  /** Response key for the rows, e.g. "transactions". */
  key: string;
  /** This BILL page's rows, already slimmed, in BILL order. */
  rows: Record<string, unknown>[];
  /** BILL's cursor for the page after this one, when it gave one. */
  nextPage?: string;
  /** Row field summed into `pageTotal` (default `amount`); `null` to omit. */
  sumField?: string | null;
  /** Echoed filters (date range, budget, status) for a self-describing result. */
  filters?: Record<string, unknown>;
  /**
   * Per filter, how it was actually enforced — server-side, dropped here, or
   * sent and not honored (see `FilterCheck`, src/divvy-filters.ts). Echoing a
   * filter says only what was asked; this says what happened, which is the
   * difference between #29 being invisible and being stated in the result.
   */
  filtering?: Record<string, string>;
  /**
   * Per paging knob, how it was really enforced (see `PagingCheck`,
   * src/divvy-paging.ts). The same idea as `filtering`, for the parameters that
   * decide which rows come back rather than which ones stay: BILL answers a
   * query parameter it does not read with 200 and a page, so being ignored is
   * invisible unless the result says what was witnessed.
   */
  paging?: Record<string, string>;
  /**
   * BILL's cursor did not advance — it re-served a page already returned, so the
   * walk stopped rather than looping (issue #33). There is no cursor to hand
   * back, and `truncatedBy: "cursor"` says which of the two that is.
   */
  cursorStalled?: boolean;
  /** BILL pages consumed for this one result, when more than one. */
  billPages?: number;
  /**
   * Independent sources consulted for this result, for the zero-row case.
   * Omitted means none were — which is what the `empty` block then says, since
   * "the source returned nothing" and "there is nothing" are different claims
   * (see `src/empty-listing.ts`).
   */
  witnesses?: Witness[];
}

/**
 * One page of a BILL list, bounded by the result-size budget, stated in the
 * same vocabulary as the QBO lists — `returned`, `hasMore`, `truncatedBy`,
 * `pageTotal`, `note` — with the one difference BILL forces: the position is
 * its opaque `nextPage` cursor, not a row offset.
 *
 * That difference is why the `hasMore` reasons need different advice.
 * `window` — BILL has more pages — resumes with `page: nextPage`. `size` — the
 * budget cut this page short — cannot: the cursor points past the whole BILL
 * page, so following it would silently skip the rows we dropped. The way
 * forward there is the SAME `page` again with a smaller `pageSize`, and the
 * note says so. `cursor` — BILL re-served a page already returned — has no way
 * forward at all, and says that rather than handing back a cursor that loops
 * (issue #33).
 *
 * There is no `rowCount`: BILL's list returns neither a total nor a page
 * count, and an omitted count beats an invented one.
 */
export function buildCursorList({
  entity,
  key,
  rows,
  nextPage,
  sumField = "amount",
  filters = {},
  filtering,
  paging,
  cursorStalled = false,
  billPages,
  witnesses,
}: CursorListInput): Record<string, unknown> {
  const page = packRows(rows, 0, undefined);
  const returned = page.rows.length;
  const sizeTruncated = returned < rows.length;
  // A stalled cursor means there ARE more rows and no way to ask for them, so
  // `hasMore` stays true: claiming the list ended would be the quieter lie.
  const hasMore = sizeTruncated || cursorStalled || Boolean(nextPage);

  const pageTotal =
    sumField === null
      ? undefined
      : round2(
          page.rows.reduce((s, r) => {
            const v = r[sumField];
            return s + (typeof v === "number" ? v : 0);
          }, 0),
        );

  const note = sizeTruncated
    ? `Showing ${returned} of the ${rows.length} rows on this page — the size budget cut it short. ` +
      "Call again with the SAME `page` and a smaller `pageSize`; `nextPage` starts after all " +
      `${rows.length} rows, so following it here would skip the rest of this page.`
    : cursorStalled
      ? "BILL's cursor did not advance — it re-served a page already returned, so the rest of this list cannot " +
        "be reached by paging and no cursor is handed back. `paging.page` says what was witnessed."
      : `Showing ${returned} row${returned === 1 ? "" : "s"}. Call again with \`page: nextPage\` for the next page` +
        `${pageTotal !== undefined ? "; `pageTotal` is this page only" : ""}.`;

  return {
    entity,
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== "")),
    ...(filtering && Object.keys(filtering).length > 0 ? { filtering } : {}),
    ...(paging && Object.keys(paging).length > 0 ? { paging } : {}),
    ...(billPages !== undefined && billPages > 1 ? { billPages } : {}),
    returned,
    ...(pageTotal !== undefined ? { pageTotal } : {}),
    hasMore,
    ...(returned === 0 ? { empty: describeEmpty(witnesses) } : {}),
    ...(hasMore
      ? {
          ...(sizeTruncated || cursorStalled ? {} : { nextPage }),
          truncatedBy: sizeTruncated ? "size" : cursorStalled ? "cursor" : "window",
          note,
        }
      : {}),
    [key]: page.rows,
  };
}
