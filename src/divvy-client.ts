import { FilterCheck } from './divvy-filters.js';
import {
  billPagingParams,
  walkBillPages,
  type BillPage,
} from './divvy-paging.js';

const DIVVY_BASE_URL = 'https://gateway.prod.bill.com/connect';

// BILL S&E web UI company segment. Stable per company; encoded base64 of
// "Company:<numeric id>". Used to build deep-link URLs into transactions.
// For multi-tenant deployments this would become per-tenant config.
const DIVVY_WEB_COMPANY = 'Q29tcGFueToxMTE3NA==';
const DIVVY_WEB_BASE = 'https://spend.bill.com/companies';

export class DivvyClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(apiToken: string) {
    this.baseUrl = DIVVY_BASE_URL;
    this.apiToken = apiToken;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    params?: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      apiToken: this.apiToken,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Divvy API error ${response.status} ${response.statusText}${text ? ': ' + text : ''}`
      );
    }

    return response.json() as Promise<T>;
  }

  private async get<T = unknown>(
    path: string,
    params?: Record<string, string | undefined>,
  ): Promise<T> {
    return this.request('GET', path, params);
  }

  private async post<T = unknown>(
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.request('POST', path, undefined, body);
  }

  /**
   * One page of any BILL list. Every paged endpoint goes through here so that
   * the cursor and page-size parameters are spelled once (`nextPage` / `max`,
   * src/divvy-paging.ts) rather than per method.
   *
   * `listCustomFieldValues` used to spell them `page` and `page_size`, which
   * BILL answers 200 to and ignores — so that list returned its first page
   * whatever cursor it was given. A name BILL does not read is invisible from
   * the response, which is exactly why it is no longer a per-method decision.
   *
   * The two names come from `billPagingParams`, i.e. from the same declaration
   * that says how each one is witnessed in the answer (`PAGING_SPECS`) — so a
   * knob cannot be sent from a place that never checks it. That is also where a
   * cursor's seal is stripped: BILL only ever sees a cursor it issued.
   */
  private async getBillPage<T = Record<string, unknown>>(
    path: string,
    params?: { filters?: string; page?: string; pageSize?: string },
  ): Promise<BillPage<T>> {
    return this.get(path, {
      filters: params?.filters,
      ...billPagingParams({ page: params?.page, pageSize: params?.pageSize }),
    });
  }

  /**
   * One page of /v3/spend/budgets.
   *
   * Never call this endpoint with no `filters` and treat the answer as "every
   * budget": on live books the unfiltered call returns nothing while
   * `retired:eq:true` returns three, and budgets a caller can read one at a
   * time by id are not returned by any filter at all (issue #34). What the
   * budget listing does with that lives in `src/divvy-budgets.ts`.
   */
  async listBudgetsPage(params?: {
    filters?: string;
    page?: string;
    pageSize?: string;
  }): Promise<BillPage<Record<string, unknown>>> {
    return this.getBillPage('/v3/spend/budgets', params);
  }

  /** One budget in full, by either spelling of its id. */
  async getBudget(budgetId: string): Promise<Record<string, unknown>> {
    return this.get(`/v3/spend/budgets/${budgetId}`);
  }

  /**
   * One page of /v3/spend/transactions.
   *
   * `filters` is BILL's own filter grammar — comma-joined `field:operator:value`
   * terms, built by `billFilterParam` (src/divvy-filters.ts). It is passed
   * through rather than assembled here so that what is asked of BILL and what
   * is checked of the answer are declared side by side.
   *
   * This used to send `start_date` / `end_date` / `budget_id` / `sync_status`,
   * which BILL does not read: it answered 200 with an unfiltered page and the
   * caller got the newest transactions whatever range they asked for
   * (issue #29). BILL validates `filters` — an unknown field or operator is a
   * 400 — so a wrong name there is loud instead of silent.
   */
  async listTransactions(params?: {
    filters?: string;
    page?: string;
    pageSize?: string;
  }): Promise<BillPage<Record<string, unknown>>> {
    return this.getBillPage('/v3/spend/transactions', params);
  }

  async getTransaction(transactionId: string): Promise<unknown> {
    return this.get(`/v3/spend/transactions/${transactionId}`);
  }

  async listCards(params?: {
    page?: string;
    pageSize?: string;
  }): Promise<BillPage<Record<string, unknown>>> {
    return this.getBillPage('/v3/spend/cards', params);
  }

  async listMembers(): Promise<unknown> {
    return this.get('/v3/spend/members');
  }

  /**
   * Upload a receipt to a transaction. Three-step flow:
   * 1. Get a pre-signed upload URL from BILL
   * 2. PUT the receipt bytes to that URL
   * 3. POST the URL back to BILL to attach it to the transaction
   */
  async getReceiptUploadUrl(): Promise<{ url: string }> {
    const resp = await this.post<Record<string, unknown>>(
      '/v3/spend/transactions/receipt-upload-url',
    );
    const url = resp && typeof resp === 'object' ? (resp as { url?: unknown }).url : undefined;
    if (typeof url !== 'string') {
      throw new Error(
        `Divvy receipt-upload-url response missing 'url' field. Got: ${JSON.stringify(resp)}`,
      );
    }
    return { url };
  }

  async uploadReceiptFile(uploadUrl: string, imageData: Buffer, contentType: string): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength) as unknown as BodyInit,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Receipt upload failed: ${response.status} ${response.statusText}${text ? ': ' + text : ''}`,
      );
    }
  }

  async attachReceiptToTransaction(transactionUuid: string, uploadUrl: string): Promise<unknown> {
    return this.post(`/v3/spend/transactions/${transactionUuid}/receipts`, { url: uploadUrl });
  }

  /**
   * One page of /v3/spend/custom-fields — the field *definitions*.
   *
   * This was an unparameterized `get`, i.e. #43's shape on a quieter endpoint:
   * BILL pages this list like every other (probed live 2026-09-23, `?max=1`
   * returns one field and the cursor `arrayconnection:0`, `?max=101` is a
   * `400 max: must be less than or equal to 100`, and `?page=` / `?page_size=`
   * are read by nothing), so a company with more field definitions than BILL's
   * page would have been served a short list with an unfollowable cursor.
   */
  async listCustomFields(params?: {
    page?: string;
    pageSize?: string;
  }): Promise<BillPage<Record<string, unknown>>> {
    return this.getBillPage('/v3/spend/custom-fields', params);
  }

  async listCustomFieldValues(
    customFieldId: string,
    params?: { page?: string; pageSize?: string },
  ): Promise<BillPage<Record<string, unknown>>> {
    return this.getBillPage(`/v3/spend/custom-fields/${customFieldId}/values`, params);
  }

  /**
   * Assign custom field values to a transaction. Each entry needs
   * `customFieldId` (the field's ID) and either `selectedValues` (value IDs,
   * for SELECT-type fields) or `note` (for NOTE-type fields).
   */
  async updateTransactionCustomFields(
    transactionUuid: string,
    customFields: Array<{ customFieldId: string; selectedValues?: string[]; note?: string }>,
  ): Promise<unknown> {
    return this.request(
      'PUT',
      `/v3/spend/transactions/${transactionUuid}/custom-fields`,
      undefined,
      { customFields },
    );
  }

  /**
   * Walk every page of /v3/spend/transactions and return rows that need
   * action: either fields are missing (PTR_INCOMPLETE / INCOMPLETE) or a
   * specific reviewer is still WAITING. Each row carries a `blockers` list
   * naming exactly what's missing, so the caller can act without re-deriving.
   *
   * `reviewerUuid`: when set, restrict to transactions where that user is
   *   listed in `reviewers[]` with `status === "WAITING"`. Useful for "what
   *   am I supposed to approve" queries.
   * `since`: optional YYYY-MM-DD lower bound on `occurredTime`. It travelled
   *   the same dead `start_date` parameter as the transaction list (issue #29)
   *   and so bounded nothing; it now goes through the same filter declaration.
   */
  async listPendingAction(params?: {
    reviewerUuid?: string;
    since?: string;
  }): Promise<{
    pendingFields: PendingActionRow[];
    pendingReview: PendingActionRow[];
  }> {
    const pendingFields: PendingActionRow[] = [];
    const pendingReview: PendingActionRow[] = [];
    const check = new FilterCheck({ startDate: params?.since });
    // The whole transaction list, through the one walker every BILL listing
    // uses. This was a hand-rolled loop that stopped on `next === cursor`; the
    // #33 witness reached it only by being pasted in (issue #60), so it goes
    // through `walkBillPages` now and inherits whatever that learns next.
    const { rows } = await walkBillPages<Record<string, unknown>>({
      list: 'transactions',
      target: Infinity,
      maxPages: PENDING_ACTION_MAX_PAGES,
      fetch: (p) =>
        this.getBillPage('/v3/spend/transactions', { filters: check.billParam, ...p }),
      keep: (got) => check.keep(got),
    });
    for (const tx of rows as unknown as RawTransaction[]) {
      if (TERMINAL_STATUSES.has(tx.status ?? '')) continue;
      const row = shapePendingRow(tx);
      if (row.blockers.length > 0) {
        pendingFields.push(row);
      } else if (
        tx.reviewRequired &&
        Array.isArray(tx.reviewers) &&
        tx.reviewers.some(
          (r) =>
            r.status === 'WAITING' &&
            (!params?.reviewerUuid || r.userUuid === params.reviewerUuid),
        )
      ) {
        pendingReview.push(row);
      }
    }
    return { pendingFields, pendingReview };
  }
}

/** The pending-action walk reads the whole transaction list, up to this many BILL pages. */
const PENDING_ACTION_MAX_PAGES = 50;

const TERMINAL_STATUSES = new Set(['APPROVED', 'COMPLETE', 'DECLINED', 'DENIED', 'REVIEWED']);

interface RawCustomField {
  uuid?: string;
  name?: string;
  isRequired?: boolean;
  selectedValues?: unknown[];
  note?: string;
}

interface RawReviewer {
  status?: string;
  userUuid?: string;
  userName?: string;
}

interface RawTransaction {
  id?: string;
  uuid?: string;
  userName?: string;
  merchantName?: string;
  amount?: number;
  occurredTime?: string;
  budgetName?: string;
  status?: string;
  receiptRequired?: boolean;
  receiptStatus?: string;
  reviewRequired?: boolean;
  customFields?: RawCustomField[];
  reviewers?: RawReviewer[];
}

export interface PendingActionRow {
  uuid: string;
  user: string;
  merchant: string;
  amount: number;
  occurredOn: string;
  budget: string;
  status: string;
  blockers: string[];
  waitingReviewers: string[];
  reviewUrl: string;
}

function shapePendingRow(tx: RawTransaction): PendingActionRow {
  const blockers: string[] = [];
  if (tx.receiptRequired && tx.receiptStatus !== 'ATTACHED') {
    blockers.push('receipt missing');
  }
  for (const f of tx.customFields ?? []) {
    if (!f.isRequired) continue;
    const hasSelected = Array.isArray(f.selectedValues) && f.selectedValues.length > 0;
    const hasNote = typeof f.note === 'string' && f.note.trim().length > 0;
    if (!hasSelected && !hasNote) {
      blockers.push(`${f.name ?? 'custom field'} missing`);
    }
  }
  const waitingReviewers = (tx.reviewers ?? [])
    .filter((r) => r.status === 'WAITING')
    .map((r) => r.userName ?? r.userUuid ?? 'unknown')
    .filter((s): s is string => Boolean(s));
  const reviewUrl = tx.id
    ? `${DIVVY_WEB_BASE}/${DIVVY_WEB_COMPANY}/transactions/pending-and-cleared/${tx.id}`
    : '';
  return {
    uuid: tx.uuid ?? '',
    user: tx.userName ?? '',
    merchant: tx.merchantName ?? '',
    amount: typeof tx.amount === 'number' ? tx.amount : 0,
    occurredOn: (tx.occurredTime ?? '').slice(0, 10),
    budget: tx.budgetName ?? '',
    status: tx.status ?? '',
    blockers,
    waitingReviewers,
    reviewUrl,
  };
}
