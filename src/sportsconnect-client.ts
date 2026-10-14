/**
 * Sports Connect (Stack Sports / Blue Sombrero) — read-only admin access for
 * one region's portal (Millbrae AYSO, portal 14883).
 *
 * Stack Sports publishes no region-level API. What the admin site itself uses
 * is reachable over plain HTTPS once signed in, so there is no browser here:
 *
 *  1. Sign-in is AWS Cognito SRP against Stack Sports' user pool — the same
 *     exchange `login.stacksports.com` runs in the page. Doing it directly
 *     matters: `login.stacksports.com` sits behind Imperva, which refuses a
 *     headless browser outright ("Access denied, Error 15"), while Cognito
 *     itself is AWS.
 *  2. The three Cognito tokens are POSTed to core-api's portal redirect, which
 *     hands out the portal's session cookies across three hosts (the region
 *     site, `ayso.bluesombrero.com`, `reporting.bluesombrero.com`).
 *  3. From then on: the reporting JSON API (`DynamicQuery/execute`) and the
 *     legacy order page, which embeds the whole order as JSON.
 *
 * The session lives in this process only. Signing in costs ~2s and needs no
 * second factor on this account, so a new instance signs in again rather than
 * a session being persisted anywhere — there is no stored session to leak.
 *
 * Read-only is structural: `request()` refuses any method/endpoint not in
 * `READ_ENDPOINTS`, so a write cannot be expressed through this client.
 */

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js";

/** Facts about the one portal this server reads. */
export const SC_PORTAL = {
  portalId: 14883,
  appName: "Millbrae AYSO (Region 145)",
  instanceKey: "ayso",
  /** The region's own site, where the legacy admin pages live. */
  siteOrigin: "https://www.millbraeayso.org",
  /** Orders module: page tab and module id, from the admin menu's "Manage Orders". */
  ordersTabId: 825475,
  ordersModuleId: 898304,
  reportingOrigin: "https://reporting.bluesombrero.com",
  coreApiOrigin: "https://core-api.bluesombrero.com",
  /** Stack Sports' Cognito user pool and app client (from the sign-in page). */
  cognitoPoolId: "us-west-2_AiiSrRjbC",
  cognitoClientId: "572but04so1ovl883vi2j95vpj",
} as const;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

/**
 * Every request this client may make. A read is a GET, plus the reporting
 * API's query endpoint, which is a POST that only reads. Anything else —
 * the order editor, a refund action, a report save — is refused here before
 * it is sent.
 */
export const READ_ENDPOINTS: Array<{ method: "GET" | "POST"; pattern: RegExp; what: string }> = [
  { method: "GET", pattern: /^https:\/\/www\.millbraeayso\.org\/Default\.aspx\?tabid=825475&mid=898304&orderId=\d+&ctl=vieworder$/, what: "order view page" },
  { method: "POST", pattern: /^https:\/\/reporting\.bluesombrero\.com\/proxy\/reporting\/api\/v1\/DynamicQuery\/execute$/, what: "report query" },
];

export function isReadEndpoint(method: string, url: string): boolean {
  return READ_ENDPOINTS.some((e) => e.method === method && e.pattern.test(url));
}

export class SportsConnectAuthError extends Error {}

interface Cookie {
  name: string;
  value: string;
  domain: string;
}

/** Just enough of a cookie jar for one portal's hosts: domain match, last write wins. */
export class CookieJar {
  private cookies: Cookie[] = [];

  store(url: string, res: Response): void {
    const host = new URL(url).hostname;
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domainAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
      const domain = domainAttr ? domainAttr.slice(7).replace(/^\./, "").toLowerCase() : host;
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain));
      if (value) this.cookies.push({ name, value, domain });
    }
  }

  header(url: string): string {
    const host = new URL(url).hostname;
    return this.cookies
      .filter((c) => host === c.domain || host.endsWith(`.${c.domain}`))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  clear(): void {
    this.cookies = [];
  }

  get size(): number {
    return this.cookies.length;
  }
}

export interface ReportQuery {
  reportKey: string;
  modelId: string;
  columns: string[];
  conditions: Array<{ id: string; operator: string; value: string; dataType: string }>;
  sort?: { id: string; direction: "asc" | "desc" };
}

export interface ReportPage {
  totalRecords: number;
  columns: string[];
  rows: Array<Record<string, string | null>>;
}

/** One portal request; the report API can take tens of seconds on a broad query. */
const REQUEST_TIMEOUT_MS = 90_000;

/** The reporting API's per-request page ceiling we ask for. */
const REPORT_PAGE_SIZE = 1000;
/** A report walk stops here; a bigger answer is reported as capped, not truncated silently. */
const REPORT_MAX_PAGES = 10;

/** True when a response is the portal sending us to sign in again. */
function isLoginBounce(res: Response, url: string): boolean {
  if (res.status === 401) return true;
  const loc = res.headers.get("location") ?? "";
  if (res.status >= 300 && res.status < 400 && /isLogin=True|login\.stacksports\.com|stackredirect/i.test(loc)) {
    return true;
  }
  return /login\.stacksports\.com/.test(url);
}

export class SportsConnectClient {
  private readonly jar = new CookieJar();
  private signIn?: Promise<void>;
  private signedInAt = 0;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  /** Cognito SRP → portal cookies. Single-flight: concurrent callers share one sign-in. */
  private ensureSignedIn(force = false): Promise<void> {
    if (force) this.signIn = undefined;
    if (!this.signIn) {
      this.signIn = this.doSignIn().catch((e) => {
        this.signIn = undefined;
        throw e;
      });
    }
    return this.signIn;
  }

  private async doSignIn(): Promise<void> {
    const start = Date.now();
    this.jar.clear();
    const pool = new CognitoUserPool({
      UserPoolId: SC_PORTAL.cognitoPoolId,
      ClientId: SC_PORTAL.cognitoClientId,
    });
    const user = new CognitoUser({ Username: this.username, Pool: pool });
    const session = await new Promise<import("amazon-cognito-identity-js").CognitoUserSession>(
      (resolve, reject) =>
        user.authenticateUser(
          new AuthenticationDetails({ Username: this.username, Password: this.password }),
          {
            onSuccess: resolve,
            onFailure: (e) => reject(new SportsConnectAuthError(`Stack Sports sign-in failed: ${e?.message ?? e}`)),
            mfaRequired: () =>
              reject(new SportsConnectAuthError("Stack Sports asked for a second factor (SMS); this server cannot answer one")),
            totpRequired: () =>
              reject(new SportsConnectAuthError("Stack Sports asked for an authenticator code; this server cannot answer one")),
            newPasswordRequired: () =>
              reject(new SportsConnectAuthError("Stack Sports requires a new password for this account; sign in by hand once")),
          },
        ),
    );

    const returnUrl = `${SC_PORTAL.reportingOrigin}/${SC_PORTAL.portalId}/admin`;
    const query = new URLSearchParams({
      app_name: SC_PORTAL.appName,
      portalid: String(SC_PORTAL.portalId),
      instancekey: SC_PORTAL.instanceKey,
      returnurl: returnUrl,
    });
    const landed = await this.follow(
      `${SC_PORTAL.coreApiOrigin}/login/redirect/portal/${SC_PORTAL.portalId}?${query}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          idToken: session.getIdToken().getJwtToken(),
          accessToken: session.getAccessToken().getJwtToken(),
          refreshToken: session.getRefreshToken().getToken(),
          redirectUri: "",
        }).toString(),
      },
    );
    if (!landed.url.startsWith(returnUrl) || landed.status !== 200) {
      throw new SportsConnectAuthError(
        `Sports Connect did not accept the Stack Sports sign-in: ended at ${landed.status} ${landed.url.split("?")[0]}`,
      );
    }
    this.signedInAt = Date.now();
    console.error(`[sportsconnect] signed in duration=${Date.now() - start}ms cookies=${this.jar.size}`);
  }

  /** Follow redirects by hand so every hop's cookies land in the jar. Sign-in only. */
  private async follow(url: string, init: RequestInit): Promise<{ status: number; url: string }> {
    for (let hop = 0; hop < 12; hop++) {
      const res = await fetch(url, {
        ...init,
        redirect: "manual",
        headers: { ...(init.headers as Record<string, string>), cookie: this.jar.header(url), "user-agent": USER_AGENT },
      });
      this.jar.store(url, res);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel();
        url = new URL(loc, url).toString();
        init = {};
        continue;
      }
      await res.body?.cancel();
      return { status: res.status, url };
    }
    throw new SportsConnectAuthError("Sports Connect sign-in redirected more than 12 times");
  }

  /**
   * One read. Refuses anything outside `READ_ENDPOINTS`; signs in on first use
   * and once more if the portal bounces us to its login (sessions last ~1h).
   */
  private async request(method: "GET" | "POST", url: string, body?: unknown): Promise<string> {
    if (!isReadEndpoint(method, url)) {
      throw new Error(`Sports Connect client is read-only: refusing ${method} ${url.split("?")[0]}`);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureSignedIn(attempt > 0);
      const res = await fetch(url, {
        method,
        redirect: "manual",
        headers: {
          cookie: this.jar.header(url),
          "user-agent": USER_AGENT,
          accept: "application/json, text/html;q=0.9, */*;q=0.8",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch((e: Error) => {
        throw new Error(
          e.name === "TimeoutError"
            ? `Sports Connect did not answer ${method} ${url.split("?")[0]} within ${REQUEST_TIMEOUT_MS / 1000}s`
            : `Sports Connect ${method} ${url.split("?")[0]} failed: ${e.message}`,
        );
      });
      this.jar.store(url, res);
      if (isLoginBounce(res, url)) {
        await res.body?.cancel();
        console.error(`[sportsconnect] session bounced to login (status=${res.status}); signing in again`);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Sports Connect ${method} ${url.split("?")[0]} → ${res.status}: ${text.slice(0, 300)}`);
      }
      return text;
    }
    throw new SportsConnectAuthError("Sports Connect kept sending this session back to its login page");
  }

  /** The order view page's HTML (it embeds the order model). */
  orderPage(orderId: string | number): Promise<string> {
    const url =
      `${SC_PORTAL.siteOrigin}/Default.aspx?tabid=${SC_PORTAL.ordersTabId}` +
      `&mid=${SC_PORTAL.ordersModuleId}&orderId=${orderId}&ctl=vieworder`;
    return this.request("GET", url);
  }

  /**
   * Run a report-wizard query and walk its pages. Rows come back keyed by the
   * column ids asked for (without the report prefix), cell values flattened.
   */
  async report(q: ReportQuery): Promise<ReportPage & { pages: number; capped: boolean }> {
    const url = `${SC_PORTAL.reportingOrigin}/proxy/reporting/api/v1/DynamicQuery/execute`;
    const rows: ReportPage["rows"] = [];
    let total = 0;
    let pages = 0;
    for (let page = 1; page <= REPORT_MAX_PAGES; page++) {
      const body = {
        portalIds: "",
        columns: q.columns.map((c) => ({ id: `${q.reportKey}.${c}`, caption: c })),
        columnNames: q.columns,
        conditions: q.conditions.map((c) => ({ ...c, value2: null })),
        modelId: q.modelId,
        reportKey: q.reportKey,
        customQuestionIds: "",
        feeDiscountQuestionIds: "",
        page,
        pageSize: REPORT_PAGE_SIZE,
        needTotal: true,
        sort: q.sort ?? { id: `${q.reportKey}.${q.columns[0]}`, direction: "desc" },
        isShowDefaultColumns: false,
      };
      const json = JSON.parse(await this.request("POST", url, body)) as {
        data?: {
          meta?: { totalRecords?: number };
          resultSet?: {
            columns: Array<{ name: string }>;
            rows: Array<Array<{ rowData?: string | null } | null>>;
          };
        };
        error?: { message?: string | null };
      };
      const rs = json.data?.resultSet;
      if (!rs) {
        throw new Error(`Sports Connect report ${q.reportKey} returned no result set: ${json.error?.message ?? "no message"}`);
      }
      pages++;
      total = json.data?.meta?.totalRecords ?? rs.rows.length;
      // Each column is asked for with its own id as the caption, and the API
      // names result columns by caption — so key rows by name, not position.
      const at = new Map(rs.columns.map((c, i) => [c.name, i]));
      const missing = q.columns.filter((c) => !at.has(c));
      if (missing.length > 0) {
        throw new Error(`Sports Connect report ${q.reportKey} did not return column(s): ${missing.join(", ")}`);
      }
      for (const r of rs.rows) {
        const row: Record<string, string | null> = {};
        for (const c of q.columns) row[c] = r[at.get(c)!]?.rowData ?? null;
        rows.push(row);
      }
      if (rows.length >= total || rs.rows.length === 0) break;
    }
    return { totalRecords: total, columns: q.columns, rows, pages, capped: rows.length < total };
  }

  get sessionAgeMs(): number {
    return this.signedInAt ? Date.now() - this.signedInAt : -1;
  }
}

export function sportsConnectClientFromEnv(): SportsConnectClient | undefined {
  const u = process.env.SPORTSCONNECT_USERNAME;
  const p = process.env.SPORTSCONNECT_PASSWORD;
  return u && p ? new SportsConnectClient(u, p) : undefined;
}
