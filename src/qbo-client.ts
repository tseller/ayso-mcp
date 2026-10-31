/**
 * QuickBooks Online (QBO) API client.
 *
 * Handles OAuth2 token refresh and provides typed methods for the
 * accounting entities a nonprofit treasurer needs most.
 */

export class QboError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody?: unknown,
  ) {
    super(message);
    this.name = "QboError";
  }
}

/**
 * QBO answers some failures with HTTP 200 and a `Fault` body instead of an
 * error status (a malformed `start_date`, for one, comes back 200 + SystemFault).
 * Without this check a Fault flows on as if it were report data and the caller
 * sees an empty/nonsense result rather than an error — the same trap already
 * guarded on /upload. Returns a human message when the body is a Fault.
 */
export function qboFaultMessage(json: unknown): string | undefined {
  const fault = (json as {
    Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }>; type?: string };
  })?.Fault;
  if (!fault) return undefined;
  const detail = (fault.Error ?? [])
    .map((e) => [e.Message, e.Detail, e.code && `code=${e.code}`].filter(Boolean).join(" — "))
    .join("; ");
  return `${fault.type ?? "unknown"}: ${detail || "no detail"}`;
}

export interface TokenStore {
  getRefreshToken(): Promise<string>;
  saveRefreshToken(token: string): Promise<void>;
}

/** In-memory token store — for stdio/local use where persistence across restarts is not required. */
export class InMemoryTokenStore implements TokenStore {
  constructor(private token: string) {}
  async getRefreshToken(): Promise<string> {
    return this.token;
  }
  async saveRefreshToken(token: string): Promise<void> {
    this.token = token;
  }
}

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  realmId: string;
  tokenStore: TokenStore;
  /** Override for sandbox testing */
  baseUrl?: string;
}

interface TokenPair {
  accessToken: string;
  expiresAt: number;
}

interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * The WHERE clause of a list query and of its COUNT(*) have to be the same
 * filter, or `rowCount` describes a different set than the rows do. They are
 * named once here and shared by the query method and the tool that counts.
 */
export const ACTIVE_ACCOUNTS = "Active = true";
export const ACTIVE_VENDORS = "Active = true";

/** QBO's query language escapes a literal apostrophe by doubling it — a vendor called "Bob's" is a valid search, not a syntax error. */
export const qboLiteral = (value: string) => value.replace(/'/g, "''");

/** The vendor-name filter shared by the search query and its COUNT(*). */
export const vendorNameWhere = (pattern: string) =>
  `DisplayName LIKE '${qboLiteral(pattern)}'`;

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const PRODUCTION_BASE = "https://quickbooks.api.intuit.com/v3/company";

export class QboClient {
  private config: QboConfig;
  private tokens: TokenPair | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(config: QboConfig) {
    this.config = config;
  }

  private get baseUrl(): string {
    const base = this.config.baseUrl || PRODUCTION_BASE;
    return `${base}/${this.config.realmId}`;
  }

  private get basicAuth(): string {
    return Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");
  }

  private async refreshTokens(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<void> {
    const initial = await this.config.tokenStore.getRefreshToken();
    let result = await this.tryRefresh(initial);

    if (result === "invalid_grant") {
      // A sibling instance may have rotated the token between our read and our refresh.
      // Re-read the store; if it's the same value, give up (operator must re-auth).
      const fresh = await this.config.tokenStore.getRefreshToken();
      if (fresh === initial) {
        throw new QboError(
          "Token refresh failed: invalid_grant (re-authorize at /qbo/auth)",
          400,
          "invalid_grant",
        );
      }
      console.error("[qbo] invalid_grant with stale token, retrying with fresh store value");
      result = await this.tryRefresh(fresh);
      if (result === "invalid_grant") {
        throw new QboError(
          "Token refresh failed: invalid_grant even after store re-read (re-authorize at /qbo/auth)",
          400,
          "invalid_grant",
        );
      }
    }

    this.tokens = {
      accessToken: result.access_token,
      expiresAt: Date.now() + result.expires_in * 1000 - 60_000, // 1 min buffer
    };

    await this.config.tokenStore.saveRefreshToken(result.refresh_token);
    console.error("[qbo] Tokens refreshed and persisted");
  }

  private async tryRefresh(refreshToken: string): Promise<IntuitTokenResponse | "invalid_grant"> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${this.basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (res.status === 400) {
      const text = await res.text();
      if (text.includes("invalid_grant")) return "invalid_grant";
      throw new QboError(`Token refresh failed: 400 ${text}`, 400, text);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`Token refresh failed: ${res.status} ${text}`, res.status, text);
    }
    return (await res.json()) as IntuitTokenResponse;
  }

  private async ensureTokens(): Promise<void> {
    if (!this.tokens || Date.now() >= this.tokens.expiresAt) {
      await this.refreshTokens();
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    await this.ensureTokens();

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.tokens!.accessToken}`,
    };
    if (body) headers["Content-Type"] = "application/json";

    let res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // Retry once on 401
    if (res.status === 401) {
      console.error("[qbo] 401, refreshing tokens...");
      await this.refreshTokens();
      headers.Authorization = `Bearer ${this.tokens!.accessToken}`;
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`QBO API error ${res.status}: ${text}`, res.status, text);
    }

    const json = await res.json();
    const fault = qboFaultMessage(json);
    if (fault) {
      throw new QboError(`QBO ${method} ${path} faulted (${fault})`, 200, json);
    }
    return json as T;
  }

  /** Run a QBO query (SQL-like syntax). */
  async query<T = unknown>(queryStr: string): Promise<T> {
    await this.ensureTokens();

    const url = `${this.baseUrl}/query?query=${encodeURIComponent(queryStr)}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.tokens!.accessToken}`,
    };

    let res = await fetch(url, { method: "GET", headers });

    if (res.status === 401) {
      await this.refreshTokens();
      headers.Authorization = `Bearer ${this.tokens!.accessToken}`;
      res = await fetch(url, { method: "GET", headers });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`QBO query error ${res.status}: ${text}`, res.status, text);
    }

    const json = await res.json();
    const fault = qboFaultMessage(json);
    if (fault) {
      throw new QboError(`QBO query faulted (${fault})`, 200, json);
    }
    return json as T;
  }

  /** Fetch a report (ProfitAndLoss, BalanceSheet, TransactionList, etc.) */
  async report(reportName: string, params: Record<string, string> = {}): Promise<unknown> {
    await this.ensureTokens();

    const url = new URL(`${this.baseUrl}/reports/${reportName}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.tokens!.accessToken}`,
    };

    let res = await fetch(url, { method: "GET", headers });

    if (res.status === 401) {
      await this.refreshTokens();
      headers.Authorization = `Bearer ${this.tokens!.accessToken}`;
      res = await fetch(url, { method: "GET", headers });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`QBO report error ${res.status}: ${text}`, res.status, text);
    }

    const json = await res.json();
    const fault = qboFaultMessage(json);
    if (fault) {
      throw new QboError(`QBO ${reportName} report faulted (${fault})`, 200, json);
    }
    return json;
  }

  /**
   * Upload a file and attach it to a transaction.
   * entityType: "Purchase", "Deposit", "Bill", etc.
   */
  async uploadAttachment(
    entityType: string,
    entityId: string,
    fileName: string,
    contentType: string,
    fileData: Buffer,
  ): Promise<unknown> {
    await this.ensureTokens();

    const boundary = `----FormBoundary${Date.now()}`;
    const metadata = JSON.stringify({
      AttachableRef: [{ EntityRef: { type: entityType, value: entityId } }],
      FileName: fileName,
      ContentType: contentType,
    });

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file_metadata_01"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file_content_01"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ];

    const bodyParts = [
      Buffer.from(parts[0]),
      Buffer.from(parts[1]),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(bodyParts);

    const url = `${this.baseUrl}/upload`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.tokens!.accessToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    let res = await fetch(url, { method: "POST", headers, body });

    if (res.status === 401) {
      await this.refreshTokens();
      headers.Authorization = `Bearer ${this.tokens!.accessToken}`;
      res = await fetch(url, { method: "POST", headers, body });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`QBO upload error ${res.status}: ${text}`, res.status, text);
    }

    // QBO's /upload returns HTTP 200 even when an individual file fails: each
    // AttachableResponse entry carries either an Attachable (success) or a Fault.
    // Surface the Fault instead of reporting a fake success.
    const json = (await res.json()) as {
      AttachableResponse?: Array<{
        Attachable?: unknown;
        Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }>; type?: string };
      }>;
    };

    const entries = json.AttachableResponse ?? [];
    const fault = entries.find((e) => e.Fault)?.Fault;
    if (fault) {
      const detail = (fault.Error ?? [])
        .map((e) => [e.Message, e.Detail, e.code && `code=${e.code}`].filter(Boolean).join(" — "))
        .join("; ");
      throw new QboError(
        `QBO upload faulted (${fault.type ?? "unknown"}): ${detail || "no detail"}`,
        200,
        json,
      );
    }
    if (!entries.some((e) => e.Attachable)) {
      throw new QboError(
        "QBO upload returned no Attachable and no Fault — file was not persisted",
        200,
        json,
      );
    }

    return json;
  }

  // --- Convenience methods ---

  async listAccounts(startPosition = 1, maxResults = 1000) {
    return this.query(
      `SELECT * FROM Account WHERE ${ACTIVE_ACCOUNTS} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async listVendors(startPosition = 1, maxResults = 100) {
    return this.query(
      `SELECT * FROM Vendor WHERE ${ACTIVE_VENDORS} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  /** Vendors whose display name matches a LIKE pattern, paged like the other lists. */
  async searchVendors(pattern: string, startPosition = 1, maxResults = 100) {
    return this.query(
      `SELECT * FROM Vendor WHERE ${vendorNameWhere(pattern)} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async getVendor(id: string) {
    return this.request("GET", `/vendor/${id}`);
  }

  async createVendor(displayName: string, extra: Record<string, unknown> = {}) {
    return this.request("POST", "/vendor", { DisplayName: displayName, ...extra });
  }

  async listCustomers(startPosition = 1, maxResults = 100) {
    return this.query(
      `SELECT * FROM Customer WHERE Active = true STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  /**
   * COUNT(*) over the same filter a list query uses, so a paged list can state
   * how many rows the whole range holds. QBO's `totalCount` on a normal query
   * is only the size of the page it just returned, so it can't answer this.
   *
   * Best-effort: a count that fails must not fail the listing, so callers get
   * `undefined` and a result without `rowCount` rather than an error.
   */
  async countEntities(entity: string, where: string): Promise<number | undefined> {
    const clause = where ? ` WHERE ${where}` : "";
    try {
      const res = await this.query<{ QueryResponse?: { totalCount?: number } }>(
        `SELECT COUNT(*) FROM ${entity}${clause}`,
      );
      const count = res?.QueryResponse?.totalCount;
      return typeof count === "number" ? count : undefined;
    } catch (e) {
      console.error(
        `[qbo] count ${entity} failed (listing continues without rowCount): ${e instanceof Error ? e.message : String(e)}`,
      );
      return undefined;
    }
  }

  async queryPurchases(where: string, startPosition = 1, maxResults = 100) {
    const clause = where ? `WHERE ${where}` : "";
    return this.query(
      `SELECT * FROM Purchase ${clause} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async getPurchase(id: string) {
    return this.request("GET", `/purchase/${id}`);
  }

  async updatePurchase(purchase: Record<string, unknown>) {
    return this.request("POST", "/purchase", purchase);
  }

  async createPurchase(purchase: Record<string, unknown>) {
    return this.request("POST", "/purchase", purchase);
  }

  async queryDeposits(where: string, startPosition = 1, maxResults = 100) {
    const clause = where ? `WHERE ${where}` : "";
    return this.query(
      `SELECT * FROM Deposit ${clause} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async getDeposit(id: string) {
    return this.request("GET", `/deposit/${id}`);
  }

  async createDeposit(deposit: Record<string, unknown>) {
    return this.request("POST", "/deposit", deposit);
  }

  async updateDeposit(deposit: Record<string, unknown>) {
    return this.request("POST", "/deposit", deposit);
  }

  async queryTransfers(where: string, startPosition = 1, maxResults = 100) {
    const clause = where ? `WHERE ${where}` : "";
    return this.query(
      `SELECT * FROM Transfer ${clause} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async createTransfer(transfer: Record<string, unknown>) {
    return this.request("POST", "/transfer", transfer);
  }

  async createJournalEntry(journalEntry: Record<string, unknown>) {
    return this.request("POST", "/journalentry", journalEntry);
  }

  async getJournalEntry(id: string) {
    return this.request("GET", `/journalentry/${id}`);
  }

  async updateJournalEntry(journalEntry: Record<string, unknown>) {
    return this.request("POST", "/journalentry", journalEntry);
  }

  // --- Classes ---

  /**
   * List Classes (the season tags: Fall / Spring / General).
   *
   * Class names are never hardcoded anywhere in this server — seasons become
   * year-specific ("Fall 2026") and that must cost nothing.
   */
  async listClasses(includeInactive = false, maxResults = 1000) {
    const where = includeInactive ? "" : "WHERE Active = true ";
    return this.query(`SELECT * FROM Class ${where}MAXRESULTS ${maxResults}`);
  }

  /**
   * The class already sitting at this name under this parent, if any — used to
   * avoid creating duplicates. "Fall 2026" at the top level and "Fall 2026"
   * under "Core" are different classes, so the parent is part of the match.
   */
  async findClassInSlot(name: string, parentClassId?: string): Promise<QboClass | undefined> {
    const all = (await this.listClasses(true)) as {
      QueryResponse?: { Class?: QboClass[] };
    };
    return findClassInSlot(all.QueryResponse?.Class ?? [], name, parentClassId);
  }

  async createClass(name: string, parentClassId?: string) {
    const body: Record<string, unknown> = { Name: name };
    if (parentClassId) {
      body.SubClass = true;
      body.ParentRef = { value: parentClassId };
    }
    return this.request("POST", "/class", body);
  }

  async getClass(id: string): Promise<QboClass> {
    const result = (await this.request("GET", `/class/${id}`)) as { Class?: QboClass };
    if (!result.Class) throw new QboError(`Class ${id} not found`, 404, result);
    return result.Class;
  }

  /** Full update: send the whole fetched class back with the changes applied. */
  async updateClass(body: QboClass) {
    return this.request("POST", "/class", body);
  }

  // --- Budgets ---

  /**
   * List Budgets. The Budget entity is READ-ONLY in the QBO Accounting API —
   * there is no create/update/delete, so budgets must be built in the QBO web
   * UI and can only be read back from here.
   */
  async listBudgets(includeInactive = false, maxResults = 100) {
    const where = includeInactive ? "" : "WHERE Active = true ";
    return this.query(`SELECT * FROM Budget ${where}MAXRESULTS ${maxResults}`);
  }

  async getBudget(id: string) {
    return this.query(`SELECT * FROM Budget WHERE Id = '${id}'`);
  }

  // --- Company preferences ---

  /** Read company Preferences (we care about AccountingInfoPrefs → class tracking mode). */
  async getPreferences(): Promise<QboPreferences> {
    return this.request<QboPreferences>("GET", "/preferences");
  }

  /**
   * How this company tracks classes. Verified live on the AYSO books:
   * ClassTrackingPerTxnLine = true, ClassTrackingPerTxn = false — i.e. ClassRef
   * belongs on each LINE DETAIL, never on the transaction header.
   *
   * The class write tools check this before writing rather than assuming, so a
   * preference flip fails loudly instead of silently writing to the wrong place.
   */
  async getClassTrackingMode(): Promise<"perLine" | "perTxn" | "off"> {
    const prefs = await this.getPreferences();
    const a = prefs.Preferences?.AccountingInfoPrefs;
    if (a?.ClassTrackingPerTxnLine) return "perLine";
    if (a?.ClassTrackingPerTxn) return "perTxn";
    return "off";
  }

  // --- Class-aware reports ---

  /**
   * Fetch a report from the ProfitAndLoss / GeneralLedger family with an
   * optional class filter, and VERIFY the filter was applied.
   *
   * Why the verification: QBO silently ignores report params it doesn't
   * support — the `account` param on TransactionList is the known example, and
   * `classid` is another (verified live: it changes nothing). The param that
   * actually works is `class`, and QBO proves it did by echoing the value back
   * as `Header.Class`. We assert that echo rather than trusting the filter, so
   * a silently-dropped filter can never masquerade as a real answer.
   */
  async classReport(
    reportName: string,
    params: {
      startDate: string;
      endDate: string;
      classIds?: string[];
      accountingMethod?: AccountingMethod;
      columns?: string[];
      summarizeColumnBy?: string;
    },
  ): Promise<unknown> {
    const q: Record<string, string> = {
      start_date: params.startDate,
      end_date: params.endDate,
    };
    if (params.accountingMethod) q.accounting_method = params.accountingMethod;
    if (params.columns?.length) q.columns = params.columns.join(",");
    if (params.summarizeColumnBy) q.summarize_column_by = params.summarizeColumnBy;
    if (params.classIds?.length) q.class = params.classIds.join(",");

    const report = await this.report(reportName, q);

    if (params.classIds?.length) {
      const echoed = (report as QboReport).Header?.Class;
      if (!echoed) {
        throw new QboError(
          `QBO ignored the class filter on the ${reportName} report (no Header.Class echo) — ` +
            `refusing to return an unfiltered report as if it were filtered.`,
          200,
          report,
        );
      }
    }
    return report;
  }
  async queryAttachables(entityType: string, entityId: string) {
    return this.query(
      `SELECT * FROM attachable WHERE AttachableRef.EntityRef.Type = '${entityType}' AND AttachableRef.EntityRef.value = '${entityId}'`,
    );
  }

  /**
   * Fetch the TransactionList report, optionally filtered by reconcile status.
   *
   * Two hard QBO API facts shape this:
   *  - The `cleared` *filter* works (values "Reconciled" | "Cleared" |
   *    "Uncleared") but is filter-only — never returned per row.
   *  - The `account` filter param is SILENTLY IGNORED (verified against live
   *    QBO: passing account=14, account=20, or none returns identical rows).
   *    So we never pass it; instead we request the `account_name` column and
   *    filter client-side by account name.
   *
   * `columns` selects which columns the report returns (and their order). We
   * request account_name + a signed natural-amount column so a reconcile
   * worksheet can attribute each row to its bank/CC account and sum it.
   */
  async transactionList(params: {
    startDate: string;
    endDate: string;
    cleared?: "Reconciled" | "Cleared" | "Uncleared";
    columns?: string[];
  }): Promise<unknown> {
    const q: Record<string, string> = {
      start_date: params.startDate,
      end_date: params.endDate,
    };
    if (params.cleared) q.cleared = params.cleared;
    if (params.columns?.length) q.columns = params.columns.join(",");
    return this.report("TransactionList", q);
  }

  /** Look up an account's display name by Id (used to filter reports client-side). */
  async getAccountName(id: string): Promise<string | undefined> {
    return (await this.getAccount(id))?.name;
  }

  /** Look up an account's name + type by Id. */
  async getAccount(id: string): Promise<{ name: string; accountType: string; accountSubType: string } | undefined> {
    const r = (await this.query(
      `SELECT Id, Name, AccountType, AccountSubType FROM Account WHERE Id = '${id}'`,
    )) as {
      QueryResponse?: { Account?: Array<{ Name?: string; AccountType?: string; AccountSubType?: string }> };
    };
    const a = r.QueryResponse?.Account?.[0];
    if (!a?.Name) return undefined;
    return { name: a.Name, accountType: a.AccountType ?? "", accountSubType: a.AccountSubType ?? "" };
  }

  /**
   * The account's register balance as of a date, read from the BalanceSheet
   * report — this is QBO's own "register balance as of <date>" (both posting
   * sides, all statuses), the number the reconcile compares against the
   * statement ending balance.
   *
   * NOTE the sign: BalanceSheet reports liabilities (incl. credit cards) as
   * POSITIVE, whereas the account register / reconcile convention shows a
   * credit-card balance owed as NEGATIVE. Callers reconciling a credit card
   * should negate this (see qbo-reconcile). Returns undefined if the account
   * isn't found on the sheet.
   */
  async accountBalanceAsOf(accountName: string, asOfDate: string): Promise<number | undefined> {
    const report = await this.report("BalanceSheet", { start_date: asOfDate, end_date: asOfDate });
    return findAccountBalanceInReport(report, accountName);
  }
}

/** QBO report accounting basis. The AYSO company's own default is Cash. */
export type AccountingMethod = "Cash" | "Accrual";

export interface QboClass {
  Id?: string;
  Name?: string;
  FullyQualifiedName?: string;
  Active?: boolean;
  SubClass?: boolean;
  ParentRef?: { value?: string; name?: string };
  SyncToken?: string;
  [key: string]: unknown;
}

const sameName = (a: string | undefined, b: string) =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/** The class with this name under this parent (no parent = top level), if one exists. */
export function findClassInSlot(
  classes: QboClass[],
  name: string,
  parentClassId?: string,
): QboClass | undefined {
  return classes.find(
    (c) => sameName(c.Name, name) && (c.ParentRef?.value ?? undefined) === (parentClassId ?? undefined),
  );
}

export interface ClassChanges {
  name?: string;
  /** A class id to nest under, or null to move the class to the top level. */
  parentClassId?: string | null;
  active?: boolean;
}

/**
 * Apply renames / re-parenting / (de)activation to a fetched class. Refuses a
 * change that would collide with another class in the destination slot or
 * nest a class under itself or one of its own descendants.
 */
export function buildClassUpdate(
  existing: QboClass,
  changes: ClassChanges,
  allClasses: QboClass[],
): QboClass {
  const body: QboClass = { ...existing };
  delete body.FullyQualifiedName;
  delete body.MetaData;
  if (changes.name !== undefined) body.Name = changes.name;
  if (changes.parentClassId !== undefined) {
    if (changes.parentClassId === null) {
      body.SubClass = false;
      delete body.ParentRef;
    } else {
      const byId = new Map(allClasses.map((c) => [c.Id, c]));
      for (let p: string | undefined = changes.parentClassId; p; p = byId.get(p)?.ParentRef?.value) {
        if (p === existing.Id) {
          throw new Error(`Class ${existing.Id} cannot be nested under itself or one of its own sub-classes`);
        }
      }
      if (!byId.has(changes.parentClassId)) throw new Error(`Parent class ${changes.parentClassId} not found`);
      body.SubClass = true;
      body.ParentRef = { value: changes.parentClassId };
    }
  }
  if (changes.active !== undefined) body.Active = changes.active;
  const clash = findClassInSlot(
    allClasses.filter((c) => c.Id !== existing.Id),
    body.Name ?? "",
    body.ParentRef?.value,
  );
  if (clash) {
    throw new Error(
      `Class ${clash.Id} "${clash.FullyQualifiedName ?? clash.Name}" already sits at that name under that parent`,
    );
  }
  return body;
}

export interface QboPreferences {
  Preferences?: {
    AccountingInfoPrefs?: {
      ClassTrackingPerTxn?: boolean;
      ClassTrackingPerTxnLine?: boolean;
      TrackDepartments?: boolean;
      UseAccountNumbers?: boolean;
      FirstMonthOfFiscalYear?: string;
    };
    ReportPrefs?: { ReportBasis?: string };
  };
}

/**
 * The report columns that carry a class.
 *
 * `klass_name` is the ONLY token QBO accepts for a class column, and it works
 * on ProfitAndLossDetail and GeneralLedger only. TransactionList SILENTLY
 * DROPS it (verified live against a deliberately-bogus column name as a
 * control: identical behaviour), which is why the class-aware transaction
 * listing is built on GeneralLedger — the one report that returns both the
 * posting Account and the Class.
 */
export const CLASS_LEDGER_COLUMNS = [
  "tx_date",
  "txn_type",
  "doc_num",
  "name",
  "memo",
  "account_name",
  "klass_name",
  "subt_nat_amount",
];

/** Strip a leading chart-of-accounts number ("1100 Chase Checking" → "Chase Checking"). */
export const stripAcctNum = (s: string) => s.replace(/^\s*\d[\d.\-]*\s+/, "").trim();
const normName = (s: string) => s.trim().toLowerCase();
/** True if a report's number-prefixed account label refers to the given account name. */
export function matchesAccount(rowAccount: string, name: string): boolean {
  const t = normName(name);
  return normName(rowAccount) === t || normName(stripAcctNum(rowAccount)) === t;
}

/** Walk a BalanceSheet (or similar) report and return the amount for the matching account row. */
export function findAccountBalanceInReport(report: unknown, accountName: string): number | undefined {
  let found: number | undefined;
  const walk = (rows: QboReportRow[] | undefined) => {
    for (const row of rows ?? []) {
      const cd = row.ColData;
      if (cd && cd.length >= 2) {
        const label = cd[0]?.value ?? "";
        if (label && matchesAccount(label, accountName)) {
          const raw = (cd[cd.length - 1]?.value ?? "").replace(/,/g, "");
          const n = Number(raw);
          if (!Number.isNaN(n)) found = n;
        }
      }
      if (row.Rows?.Row) walk(row.Rows.Row);
    }
  };
  walk((report as QboReport).Rows?.Row);
  return found;
}

/** Columns we request from the TransactionList report for reconcile worksheets. */
export const RECONCILE_COLUMNS = [
  "tx_date",
  "txn_type",
  "doc_num",
  "name",
  "memo",
  "account_name",
  "split_acc",
  "subt_nat_amount",
];

// --- TransactionList report parsing ---

export interface ReconcileTxn {
  date: string;
  type: string;
  docNumber: string;
  name: string;
  memo: string;
  /** The bank/CC (register) account this row posts to, from the report's Account column. */
  account: string;
  /** Signed amount as reported in the account register (deposits +, payments −). */
  amount: number;
  /** The other side of the entry, from the report's Split column. */
  split: string;
  /** QBO transaction Id, carried on the Transaction Type cell (lets a caller fetch the txn). */
  id: string;
  /** QBO Id of the register account, carried on the Account cell. */
  accountId: string;
  raw: Record<string, string>;
}

interface QboReportColData {
  value?: string;
  id?: string;
}
interface QboReportRow {
  ColData?: QboReportColData[];
  Rows?: { Row?: QboReportRow[] };
  type?: string;
  group?: string;
}
interface QboReportColumn {
  ColTitle?: string;
  ColType?: string;
  MetaData?: Array<{ Name?: string; Value?: string }>;
}
interface QboReport {
  Header?: {
    ReportName?: string;
    ReportBasis?: string;
    StartPeriod?: string;
    EndPeriod?: string;
    SummarizeColumnsBy?: string;
    /** QBO echoes an APPLIED `class` filter back here — absence means it was ignored. */
    Class?: string;
    Option?: Array<{ Name?: string; Value?: string }>;
  };
  Columns?: { Column?: QboReportColumn[] };
  Rows?: { Row?: QboReportRow[] };
}

/**
 * Flatten a TransactionList report into typed rows plus a signed total.
 * Handles the report's nested/grouped `Rows` and skips summary rows (which have
 * no `ColData`). Amounts are parsed from the "Amount" column.
 */
export function parseTransactionList(report: unknown): {
  transactions: ReconcileTxn[];
  total: number;
} {
  const r = report as QboReport;
  const columnDefs = r.Columns?.Column ?? [];
  const cols = columnDefs.map((c) => c.ColTitle ?? "");
  const idx = (title: string) =>
    cols.findIndex((c) => c.toLowerCase() === title.toLowerCase());
  // Amount column: match by title, else by the report's ColType metadata
  // (custom `columns` requests can retitle it, but ColType stays "Amount"/"Money").
  let amountIdx = idx("Amount");
  if (amountIdx < 0)
    amountIdx = columnDefs.findIndex((c) => /amount|money/i.test(c.ColType ?? ""));
  if (amountIdx < 0)
    amountIdx = cols.findIndex((c) => /amount/i.test(c));
  const dateIdx = idx("Date");
  const typeIdx = idx("Transaction Type");
  const numIdx = idx("Num");
  const nameIdx = idx("Name");
  const memoIdx = idx("Memo/Description");
  // account_name column comes back titled "Account" (fall back to any title
  // containing "account" that isn't the split column).
  let accountIdx = idx("Account");
  if (accountIdx < 0)
    accountIdx = cols.findIndex(
      (c) => /account/i.test(c) && !/split/i.test(c),
    );
  const splitIdx = idx("Split");

  const txns: ReconcileTxn[] = [];

  const walk = (rows: QboReportRow[] | undefined) => {
    for (const row of rows ?? []) {
      if (row.Rows?.Row) walk(row.Rows.Row);
      const cd = row.ColData;
      // Skip section/summary rows: real transaction rows carry a full ColData
      // set with an Amount cell.
      if (!cd || amountIdx < 0 || !cd[amountIdx]?.value) continue;
      const raw: Record<string, string> = {};
      cols.forEach((c, i) => {
        if (c) raw[c] = cd[i]?.value ?? "";
      });
      const amount = Number((cd[amountIdx].value ?? "0").replace(/,/g, ""));
      if (Number.isNaN(amount)) continue;
      txns.push({
        date: dateIdx >= 0 ? cd[dateIdx]?.value ?? "" : "",
        type: typeIdx >= 0 ? cd[typeIdx]?.value ?? "" : "",
        docNumber: numIdx >= 0 ? cd[numIdx]?.value ?? "" : "",
        name: nameIdx >= 0 ? cd[nameIdx]?.value ?? "" : "",
        memo: memoIdx >= 0 ? cd[memoIdx]?.value ?? "" : "",
        account: accountIdx >= 0 ? cd[accountIdx]?.value ?? "" : "",
        amount,
        split: splitIdx >= 0 ? cd[splitIdx]?.value ?? "" : "",
        id: typeIdx >= 0 ? cd[typeIdx]?.id ?? "" : "",
        accountId: accountIdx >= 0 ? cd[accountIdx]?.id ?? "" : "",
        raw,
      });
    }
  };
  walk(r.Rows?.Row);

  const total = txns.reduce((s, t) => s + t.amount, 0);
  return { transactions: txns, total: Math.round(total * 100) / 100 };
}

// --- Class-aware report parsing ---

/** Build a title→index lookup over a report's Columns, tolerant of QBO's retitling. */
function columnTitles(report: QboReport): string[] {
  return (report.Columns?.Column ?? []).map((c) => c.ColTitle ?? "");
}

export interface ClassLedgerTxn {
  date: string;
  type: string;
  docNumber: string;
  name: string;
  memo: string;
  /** Posting account, from the report's Account column. */
  account: string;
  /** Class name, or "" when the line is untagged. */
  className: string;
  amount: number;
  /** QBO transaction Id, carried on the Transaction Type cell — feed straight to qbo_set_transaction_class. */
  id: string;
  /** QBO Id of the posting account, carried on the Account cell. */
  accountId: string;
  raw: Record<string, string>;
}

/**
 * Flatten a GeneralLedger report (requested with CLASS_LEDGER_COLUMNS) into
 * typed transaction rows carrying their class.
 *
 * GeneralLedger nests rows inside per-account sections and interleaves
 * "Beginning Balance" / account-total / grand-total rows that DO carry an
 * Amount cell — so, unlike TransactionList, an Amount alone is not enough to
 * identify a transaction row. A real transaction row has both a Date and a
 * Transaction Type; the running-balance and summary rows have neither.
 */
export function parseClassLedger(report: unknown): {
  transactions: ClassLedgerTxn[];
  total: number;
  basis: string;
  classFilterEcho?: string;
} {
  const r = report as QboReport;
  const cols = columnTitles(r);
  const idx = (title: string) => cols.findIndex((c) => c.toLowerCase() === title.toLowerCase());

  const dateIdx = idx("Date");
  const typeIdx = idx("Transaction Type");
  const numIdx = idx("Num");
  const nameIdx = idx("Name");
  const memoIdx = idx("Memo/Description");
  const classIdx = idx("Class");
  let accountIdx = idx("Account");
  if (accountIdx < 0) accountIdx = cols.findIndex((c) => /account/i.test(c) && !/split/i.test(c));
  let amountIdx = idx("Amount");
  if (amountIdx < 0) {
    const defs = r.Columns?.Column ?? [];
    amountIdx = defs.findIndex((c) => /amount|money/i.test(c.ColType ?? ""));
  }

  const txns: ClassLedgerTxn[] = [];
  const cell = (cd: QboReportColData[], i: number) => (i >= 0 ? cd[i]?.value ?? "" : "");

  const walk = (rows: QboReportRow[] | undefined) => {
    for (const row of rows ?? []) {
      if (row.Rows?.Row) walk(row.Rows.Row);
      const cd = row.ColData;
      if (!cd || amountIdx < 0) continue;
      const date = cell(cd, dateIdx);
      const type = cell(cd, typeIdx);
      // Summary / beginning-balance rows carry an amount but no date+type pair.
      if (!date || !type) continue;
      const amount = Number((cd[amountIdx]?.value ?? "").replace(/,/g, ""));
      if (Number.isNaN(amount)) continue;
      const raw: Record<string, string> = {};
      cols.forEach((c, i) => {
        if (c) raw[c] = cd[i]?.value ?? "";
      });
      txns.push({
        date,
        type,
        docNumber: cell(cd, numIdx),
        name: cell(cd, nameIdx),
        memo: cell(cd, memoIdx),
        account: cell(cd, accountIdx),
        className: cell(cd, classIdx),
        amount,
        id: typeIdx >= 0 ? cd[typeIdx]?.id ?? "" : "",
        accountId: accountIdx >= 0 ? cd[accountIdx]?.id ?? "" : "",
        raw,
      });
    }
  };
  walk(r.Rows?.Row);

  const total = txns.reduce((s, t) => s + t.amount, 0);
  return {
    transactions: txns,
    total: Math.round(total * 100) / 100,
    basis: r.Header?.ReportBasis ?? "",
    classFilterEcho: r.Header?.Class,
  };
}

export interface ClassColumn {
  index: number;
  title: string;
  /** QBO's own column key: an id for a real class, "not_specified", or "total". */
  colKey: string;
  classId?: string;
  isUntagged: boolean;
  isTotal: boolean;
}

export interface ClassPlRow {
  account: string;
  accountId?: string;
  /** Amount per class column, keyed by that column's title. */
  byClass: Record<string, number>;
}

/**
 * Parse a ProfitAndLoss report requested with summarize_column_by=Classes.
 *
 * Column identity comes from QBO's own `MetaData.ColKey`: a numeric key is the
 * Class id, "not_specified" is the untagged bucket (the number that answers
 * "how much is still untagged?"), and "total" is the row total. Titles are only
 * a fallback — class names change ("Fall 2026") and must never be matched on
 * by hardcoded string.
 */
export function parseProfitAndLossByClass(report: unknown): {
  basis: string;
  summarizedBy: string;
  columns: ClassColumn[];
  rows: ClassPlRow[];
} {
  const r = report as QboReport;
  const defs = r.Columns?.Column ?? [];

  const columns: ClassColumn[] = [];
  defs.forEach((c, i) => {
    if ((c.ColType ?? "") === "Account") return; // the row-label column
    const colKey = c.MetaData?.find((m) => m.Name === "ColKey")?.Value ?? "";
    columns.push({
      index: i,
      title: c.ColTitle ?? "",
      colKey,
      classId: /^\d+$/.test(colKey) ? colKey : undefined,
      isUntagged: colKey === "not_specified",
      isTotal: colKey === "total",
    });
  });

  const rows: ClassPlRow[] = [];
  const walk = (rs: QboReportRow[] | undefined) => {
    for (const row of rs ?? []) {
      const cd = row.ColData;
      if (cd && cd.length > 1) {
        const label = cd[0]?.value ?? "";
        if (label) {
          const byClass: Record<string, number> = {};
          for (const col of columns) {
            const raw = (cd[col.index]?.value ?? "").replace(/,/g, "");
            const n = Number(raw);
            byClass[col.title] = raw === "" || Number.isNaN(n) ? 0 : n;
          }
          rows.push({ account: label, accountId: cd[0]?.id, byClass });
        }
      }
      if (row.Rows?.Row) walk(row.Rows.Row);
    }
  };
  walk(r.Rows?.Row);

  return {
    basis: r.Header?.ReportBasis ?? "",
    summarizedBy: r.Header?.SummarizeColumnsBy ?? "",
    columns,
    rows,
  };
}
