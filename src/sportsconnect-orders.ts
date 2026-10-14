/**
 * Sports Connect orders: reading one, finding them, and finding refunds.
 *
 * The order view page (`ctl=vieworder`) embeds the whole order as JSON in a
 * hidden field — the same model its own script renders the page from. That
 * model is the authority here: every payment, every refund and every amount a
 * tool reports comes from it, never from a report row.
 *
 * A refund is a payment row with a negative amount, pointing back at the
 * payment it returns (`RefundOrderPaymentHistoryID`). A cancellation keeps the
 * original order date, so "refunds since X" cannot be a filter on order date —
 * see `findRefunds`.
 */

import type { ReportQuery, SportsConnectClient } from "./sportsconnect-client.js";

// ---------------------------------------------------------------------------
// The embedded order model

interface RawPayment {
  OrderPaymentHistoryId: number;
  OldOrderPaymentHistoryID?: number | null;
  RefundOrderPaymentHistoryID?: number | null;
  PaymentAmount: number;
  PaymentDate?: string | null;
  PaymentDateString?: string | null;
  PaymentStatusString?: string | null;
  PaymentMethod?: string | null;
  CreditCardType?: string | null;
  CreditCardNumber?: string | null;
  TransactionId?: string | null;
  PaymentDescription?: string | null;
  AdjustmentMemo?: string | null;
  OrderNotes?: string | null;
}

interface RawItem {
  OrderDetailId: number;
  PlayerFirstName?: string | null;
  PlayerLastName?: string | null;
  PlayerId?: number | null;
  ProgramName?: string | null;
  DivisionName?: string | null;
  Details?: string | null;
  Price?: number | null;
  PaymentAmount?: number | null;
  BalanceAmount?: number | null;
  Note?: string | null;
}

export interface RawOrder {
  OrderId: number;
  OrderDate?: string | null;
  CustomerName?: string | null;
  OrderAmount?: number | null;
  PaymentAmount?: number | null;
  OpenBalance?: number | null;
  PaymentStatusString?: string | null;
  CancelOrTransferDate?: string | null;
  oldorderid?: number | null;
  OrderItems?: RawItem[] | null;
  OrderPayments?: RawPayment[] | null;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");

/**
 * The order model embedded in an order view page. Throws a named error when
 * the page carries none — which is what the portal's login page, or an order
 * id this portal does not have, looks like.
 */
export function parseOrderPage(html: string, orderId: string | number): RawOrder {
  for (const m of html.matchAll(/value="(\{&quot;[^"]*)"/g)) {
    const text = decodeEntities(m[1]);
    if (!text.includes('"OrderItems"')) continue;
    let model: RawOrder;
    try {
      model = JSON.parse(text) as RawOrder;
    } catch {
      continue;
    }
    if (String(model.OrderId) === String(orderId)) return model;
  }
  if (/login\.stacksports\.com|isLogin=True/i.test(html) && !html.includes("OrderItems")) {
    throw new Error(`Sports Connect served its login page for order ${orderId}, not the order`);
  }
  throw new Error(`Sports Connect has no order ${orderId} on this portal (its order page carried no order)`);
}

// ---------------------------------------------------------------------------
// The flattened order

export interface PaymentRow {
  /** Sports Connect's payment-history id — what a refund points back at. */
  id: number;
  kind: "payment" | "refund";
  date: string | null;
  amount: number;
  status: string | null;
  method: string | null;
  card?: string;
  transactionId?: string;
  /** For a refund: the payment it returns. */
  refundOf?: number;
  /** For a payment carried over from an earlier order on a cancel/transfer. */
  carriedFrom?: number;
  note?: string;
}

export interface ItemRow {
  player: string | null;
  program: string | null;
  division: string | null;
  description: string | null;
  price?: number;
  paid?: number;
  balance?: number;
}

export interface OrderRow {
  orderId: number;
  orderDate: string | null;
  account: string | null;
  status: string | null;
  orderAmount: number | null;
  /** Net of refunds, as Sports Connect states it. */
  paid: number | null;
  openBalance: number | null;
  /** Sum of the refund rows below. */
  refunded: number;
  cancelledOrTransferredOn?: string;
  /** The order this one replaced on a cancel/transfer. */
  previousOrderId?: number;
  players: string[];
  items: ItemRow[];
  payments: PaymentRow[];
}

const day = (s: string | null | undefined): string | null => (s ? s.slice(0, 10) : null);
const money = (n: number | null | undefined): number | null =>
  n == null ? null : Math.round(n * 100) / 100;
const fullName = (first?: string | null, last?: string | null): string | null =>
  [first, last].filter(Boolean).join(" ") || null;

export function isRefund(p: Pick<RawPayment, "PaymentAmount" | "RefundOrderPaymentHistoryID">): boolean {
  return p.PaymentAmount < 0 || (p.RefundOrderPaymentHistoryID ?? 0) > 0;
}

/**
 * A refund row that is money actually returned. A cancel/transfer copies the
 * old order's payment rows — refunds included — onto the order that replaces
 * it and marks the old copies `Cancelled`, so the same refund can appear on
 * both orders (seen on a 2021 order here). Only the live copy counts; a
 * `Failed` refund returned nothing.
 */
export function countsAsRefund(p: Pick<PaymentRow, "kind" | "status">): boolean {
  return p.kind === "refund" && p.status !== "Failed" && p.status !== "Cancelled";
}

export function slimOrder(o: RawOrder): OrderRow {
  const payments: PaymentRow[] = (o.OrderPayments ?? []).map((p) => {
    const refund = isRefund(p);
    const note = [p.PaymentDescription, p.AdjustmentMemo, p.OrderNotes].filter((x) => x && x.trim()).join(" · ");
    return {
      id: p.OrderPaymentHistoryId,
      kind: refund ? "refund" : "payment",
      date: day(p.PaymentDate),
      amount: money(p.PaymentAmount) ?? 0,
      status: p.PaymentStatusString ?? null,
      method: p.PaymentMethod ?? null,
      ...(p.CreditCardNumber ? { card: `${p.CreditCardType ?? "card"} …${p.CreditCardNumber}` } : {}),
      ...(p.TransactionId ? { transactionId: p.TransactionId } : {}),
      ...(refund && p.RefundOrderPaymentHistoryID ? { refundOf: p.RefundOrderPaymentHistoryID } : {}),
      ...(p.OldOrderPaymentHistoryID ? { carriedFrom: p.OldOrderPaymentHistoryID } : {}),
      ...(note ? { note } : {}),
    };
  });
  const items: ItemRow[] = (o.OrderItems ?? []).map((i) => ({
    player: fullName(i.PlayerFirstName, i.PlayerLastName),
    program: i.ProgramName ?? null,
    division: i.DivisionName ?? null,
    description: i.Details ?? i.Note ?? null,
    ...(i.Price ? { price: money(i.Price)! } : {}),
    ...(i.PaymentAmount ? { paid: money(i.PaymentAmount)! } : {}),
    ...(i.BalanceAmount ? { balance: money(i.BalanceAmount)! } : {}),
  }));
  const refunded = money(payments.filter(countsAsRefund).reduce((s, p) => s + Math.abs(p.amount), 0))!;
  return {
    orderId: o.OrderId,
    orderDate: day(o.OrderDate),
    account: o.CustomerName ?? null,
    status: o.PaymentStatusString ?? null,
    orderAmount: money(o.OrderAmount),
    paid: money(o.PaymentAmount),
    openBalance: money(o.OpenBalance),
    refunded,
    // The portal stamps this on creation too; only a later stamp says something happened.
    ...(o.CancelOrTransferDate && day(o.CancelOrTransferDate) !== day(o.OrderDate) && !o.CancelOrTransferDate.startsWith("0001")
      ? { cancelledOrTransferredOn: day(o.CancelOrTransferDate)! }
      : {}),
    ...(o.oldorderid ? { previousOrderId: o.oldorderid } : {}),
    players: [...new Set(items.map((i) => i.player).filter((p): p is string => !!p))],
    items,
    payments,
  };
}

/** Read and flatten one order. */
export async function getOrder(client: SportsConnectClient, orderId: string | number): Promise<OrderRow> {
  return slimOrder(parseOrderPage(await client.orderPage(orderId), orderId));
}

/** Read many orders, a few at a time. A failed read is reported, not dropped. */
export async function getOrders(
  client: SportsConnectClient,
  ids: Array<string | number>,
  concurrency = 6,
): Promise<{ orders: OrderRow[]; failed: Array<{ orderId: string; error: string }> }> {
  const orders: OrderRow[] = [];
  const failed: Array<{ orderId: string; error: string }> = [];
  const queue = [...ids];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          orders.push(await getOrder(client, id));
        } catch (e) {
          failed.push({ orderId: String(id), error: (e as Error).message });
        }
      }
    }),
  );
  // Reads share one ASP.NET session, and under concurrency the portal now and
  // then answers a page it serves fine a moment later with an "Access Denied"
  // redirect (seen once in 263 reads). So a failure gets one more try, alone.
  const retried: typeof failed = [];
  for (const f of failed) {
    try {
      orders.push(await getOrder(client, f.orderId));
    } catch (e) {
      retried.push({ orderId: f.orderId, error: (e as Error).message });
    }
  }
  orders.sort((a, b) => b.orderId - a.orderId);
  return { orders, failed: retried };
}

// ---------------------------------------------------------------------------
// Finding orders: the Line Item Order report

const LINE_ITEMS = {
  reportKey: "ReportWizardLineItemOrderNewRegistration",
  modelId: "ReportWizard_LineItemOrder_New_Registration",
} as const;

/** "M/D/YYYY …" (the report's date format) → "YYYY-MM-DD". */
export function reportDate(s: string | null | undefined): string | null {
  const m = s?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

/** "YYYY-MM-DD" → "M/D/YYYY", the report API's condition format. */
export function toReportDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
}

const norm = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Every word of the asked name appears in the candidate's name. */
export function nameMatches(asked: string, candidate: string | null): boolean {
  const have = ` ${norm(candidate)} `;
  return norm(asked)
    .split(" ")
    .filter(Boolean)
    .every((w) => have.includes(` ${w}`));
}

export type NameField = "player" | "account";

const NAME_COLUMNS: Record<NameField, { first: string; last: string }> = {
  player: { first: "PlayersFirstName", last: "PlayersLastName" },
  account: { first: "UsersFirstName", last: "UsersLastName" },
};

export interface OrderSearch {
  orderIds: string[];
  /** How the name was really enforced — the report's filter is checked against each row. */
  matching: string;
  reportRows: number;
}

/**
 * Orders naming a player (or account holder). The report is asked for a
 * last-name `Contains` — an operator it does not know returns zero rows rather
 * than an error, so every row that comes back is checked against the whole
 * name here, and the result says how many the report sent and how many held.
 */
export async function findOrdersByName(
  client: SportsConnectClient,
  name: string,
  field: NameField,
): Promise<OrderSearch> {
  const words = norm(name).split(" ").filter(Boolean);
  if (words.length === 0) throw new Error("A name to search for is required");
  const cols = NAME_COLUMNS[field];
  const last = words[words.length - 1];
  const q: ReportQuery = {
    ...LINE_ITEMS,
    columns: ["OrdersOrderId", cols.first, cols.last],
    conditions: [{ id: cols.last, operator: "Contains", value: last, dataType: "String" }],
  };
  const page = await client.report(q);
  const held = page.rows.filter((r) => nameMatches(name, `${r[cols.first] ?? ""} ${r[cols.last] ?? ""}`));
  const ids = [...new Set(held.map((r) => r.OrdersOrderId).filter((x): x is string => !!x))].sort(
    (a, b) => Number(b) - Number(a),
  );
  return {
    orderIds: ids,
    reportRows: page.rows.length,
    matching:
      `report asked for ${field} last name containing "${last}" and sent ${page.rows.length} line item(s); ` +
      `${held.length} matched every word of "${name}" here, across ${ids.length} order(s)` +
      (page.capped ? `; the report held ${page.totalRecords} rows and only ${page.rows.length} were read` : ""),
  };
}

// ---------------------------------------------------------------------------
// Finding refunds

export interface RefundRow {
  date: string | null;
  amount: number;
  orderId: number;
  account: string | null;
  players: string[];
  status: string | null;
  card?: string;
  transactionId?: string;
  /** The payment it returned (its date and amount when that payment is on the same order). */
  refundOf?: { id: number; date?: string | null; amount?: number };
  note?: string;
}

/**
 * Orders that could carry a refund dated on or after `since`.
 *
 * Sports Connect has no refund listing reachable from this login (the billing
 * reports answer 500 even in its own UI), and a refund leaves the order date
 * alone. What a refund does is change the order: it is made by cancelling or
 * transferring a registration, which stamps the order's cancel/transfer date,
 * and it rewrites the order's line items, which stamps their updated date. So
 * the candidates are every order either stamp says changed since `since` — and
 * each stamp is re-checked against the rows here, since this report answers an
 * unhonoured condition with rows rather than an error.
 */
async function refundCandidates(
  client: SportsConnectClient,
  since: string,
): Promise<{ ids: string[]; sources: Record<string, string> }> {
  const stamps = ["OrdersCancelOrTransferDate", "OrderDetailUpdatedDate"] as const;
  const sources: Record<string, string> = {};
  const ids = new Set<string>();
  for (const stamp of stamps) {
    const page = await client.report({
      ...LINE_ITEMS,
      columns: ["OrdersOrderId", stamp],
      conditions: [{ id: stamp, operator: "IsAfterPrecise", value: toReportDate(since), dataType: "Date" }],
    });
    const held = page.rows.filter((r) => (reportDate(r[stamp]) ?? "") >= since);
    const orders = new Set(held.map((r) => r.OrdersOrderId).filter((x): x is string => !!x));
    orders.forEach((o) => ids.add(o));
    sources[stamp] =
      `${orders.size} order(s) — ${page.rows.length} line item(s) sent, ${held.length} dated on/after ${since}` +
      (page.capped ? `; capped at ${page.rows.length} of ${page.totalRecords}` : "");
  }
  return { ids: [...ids], sources };
}

/** Orders one refund search will read (~0.3s each, six at a time). */
export const MAX_REFUND_CANDIDATES = 400;

export interface RefundSearch {
  refunds: RefundRow[];
  total: number;
  ordersChecked: number;
  candidates: Record<string, string>;
  failed: Array<{ orderId: string; error: string }>;
}

export function refundsOn(order: OrderRow, since: string, until?: string): RefundRow[] {
  const byId = new Map(order.payments.map((p) => [p.id, p]));
  return order.payments
    .filter((p) => countsAsRefund(p) && p.date && p.date >= since && (!until || p.date <= until))
    .map((p) => {
      const orig = p.refundOf ? byId.get(p.refundOf) : undefined;
      return {
        date: p.date,
        amount: Math.abs(p.amount),
        orderId: order.orderId,
        account: order.account,
        players: order.players,
        status: p.status,
        ...(p.card ? { card: p.card } : {}),
        ...(p.transactionId ? { transactionId: p.transactionId } : {}),
        ...(orig
          ? { refundOf: { id: orig.id, date: orig.date, amount: orig.amount } }
          : p.refundOf
            ? { refundOf: { id: p.refundOf } }
            : {}),
        ...(p.note ? { note: p.note } : {}),
      };
    });
}

export async function findRefunds(
  client: SportsConnectClient,
  since: string,
  until?: string,
): Promise<RefundSearch> {
  const { ids, sources } = await refundCandidates(client, since);
  if (ids.length > MAX_REFUND_CANDIDATES) {
    throw new Error(
      `${ids.length} orders changed since ${since}, and each has to be read to find its refunds; ` +
        `one call reads at most ${MAX_REFUND_CANDIDATES}. Ask for a later \`since\`.`,
    );
  }
  const { orders, failed } = await getOrders(client, ids);
  const refunds = orders
    .flatMap((o) => refundsOn(o, since, until))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.orderId - b.orderId);
  return {
    refunds,
    total: Math.round(refunds.reduce((s, r) => s + r.amount, 0) * 100) / 100,
    ordersChecked: orders.length,
    candidates: sources,
    failed,
  };
}
