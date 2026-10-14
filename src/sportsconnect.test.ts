import { test } from "node:test";
import assert from "node:assert/strict";
import { SC_PORTAL, isReadEndpoint, type ReportQuery, type SportsConnectClient } from "./sportsconnect-client.js";
import {
  findOrdersByName,
  findRefunds,
  nameMatches,
  parseOrderPage,
  refundsOn,
  reportDate,
  slimOrder,
  toReportDate,
  type RawOrder,
} from "./sportsconnect-orders.js";

// A synthetic order shaped like the portal's embedded model: a registration
// cancelled into a new order, carrying its payment over and refunding part of
// it to the card. (Names and numbers invented — this repository is public.)
const ORDER: RawOrder = {
  OrderId: 900002,
  OrderDate: "2026-05-02T12:01:18.23",
  CustomerName: "Pat Example",
  OrderAmount: 28.5,
  PaymentAmount: 28.5,
  OpenBalance: 0,
  PaymentStatusString: "Completed",
  CancelOrTransferDate: "2026-07-30T12:17:44.983",
  oldorderid: 900001,
  OrderItems: [
    { OrderDetailId: 1, PlayerFirstName: "Sam", PlayerLastName: "Example", ProgramName: "Fall", DivisionName: "08U", Details: "Cancellation", PaymentAmount: 28.5 },
    { OrderDetailId: 2, PlayerFirstName: "Sam", PlayerLastName: "Example", ProgramName: "Fall", DivisionName: "08U", Details: "AYSO Membership Fee", Price: 25 },
  ],
  OrderPayments: [
    { OrderPaymentHistoryId: 501, OldOrderPaymentHistoryID: 400, PaymentAmount: 268.5, PaymentDate: "2026-05-02T12:01:20", PaymentStatusString: "Completed", PaymentMethod: "Credit Card", CreditCardType: "Visa", CreditCardNumber: "1234", TransactionId: "T1" },
    { OrderPaymentHistoryId: 502, RefundOrderPaymentHistoryID: 501, PaymentAmount: -240, PaymentDate: "2026-07-30T12:18:00", PaymentStatusString: "Completed", PaymentMethod: "Credit Card", CreditCardType: "Visa", CreditCardNumber: "1234", TransactionId: "T2" },
  ],
};

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const page = (model: unknown) =>
  `<html><input type="hidden" value="{&quot;unrelated&quot;:1}" />` +
  `<input type="hidden" id="x" value="${escape(JSON.stringify(model))}" /></html>`;

test("the order page's embedded model is the order, entities decoded", () => {
  const m = parseOrderPage(page(ORDER), 900002);
  assert.equal(m.OrderId, 900002);
  assert.equal(m.OrderPayments?.length, 2);
});

test("a page without the order is a named error, never an empty order", () => {
  assert.throws(() => parseOrderPage(`<a href="https://login.stacksports.com/login">`, 1), /login page/);
  assert.throws(() => parseOrderPage(page({ ...ORDER, OrderId: 7 }), 900002), /no order 900002/);
});

test("a refund is the negative payment, linked to the payment it returned", () => {
  const o = slimOrder(ORDER);
  assert.equal(o.refunded, 240);
  assert.equal(o.previousOrderId, 900001);
  assert.equal(o.cancelledOrTransferredOn, "2026-07-30");
  assert.deepEqual(o.players, ["Sam Example"]);
  const [pay, refund] = o.payments;
  assert.equal(pay.kind, "payment");
  assert.equal(pay.carriedFrom, 400);
  assert.equal(refund.kind, "refund");
  assert.equal(refund.refundOf, 501);
  assert.equal(refund.card, "Visa …1234");
});

test("refundsOn keeps the asked window, inclusive, and names the original payment", () => {
  const o = slimOrder(ORDER);
  assert.equal(refundsOn(o, "2026-07-31").length, 0);
  assert.equal(refundsOn(o, "2026-07-01", "2026-07-29").length, 0);
  const [r] = refundsOn(o, "2026-07-30", "2026-07-30");
  assert.equal(r.amount, 240);
  assert.deepEqual(r.refundOf, { id: 501, date: "2026-05-02", amount: 268.5 });
});

test("names match on every word, case- and punctuation-blind", () => {
  assert.ok(nameMatches("sam example", "Sam Example"));
  assert.ok(nameMatches("Example", "Sam Example"));
  assert.ok(nameMatches("O'Neil", "Kim O Neil"));
  assert.ok(!nameMatches("Sam Example", "Samantha Other"));
  assert.ok(!nameMatches("Ample", "Sam Example"), "a word matches from its start, not its middle");
});

test("report dates round-trip", () => {
  assert.equal(reportDate("7/30/2026 12:17:44 PM"), "2026-07-30");
  assert.equal(toReportDate("2026-07-05"), "7/5/2026");
  assert.equal(reportDate(null), null);
});

test("the client can express only reads", () => {
  const order = `${SC_PORTAL.siteOrigin}/Default.aspx?tabid=825475&mid=898304&orderId=1&ctl=vieworder`;
  const query = `${SC_PORTAL.reportingOrigin}/proxy/reporting/api/v1/DynamicQuery/execute`;
  assert.ok(isReadEndpoint("GET", order));
  assert.ok(isReadEndpoint("POST", query));
  assert.ok(!isReadEndpoint("POST", order), "posting back the order page is the order editor");
  assert.ok(!isReadEndpoint("GET", order.replace("vieworder", "manageorder")));
  assert.ok(!isReadEndpoint("POST", `${SC_PORTAL.reportingOrigin}/proxy/reporting/api/v1/Report/save`));
});

/** A client whose report answers from `rows` and whose orders are `orders`. */
function fakeClient(rows: (q: ReportQuery) => Array<Record<string, string | null>>, orders: RawOrder[] = []) {
  const asked: ReportQuery[] = [];
  const client = {
    report: async (q: ReportQuery) => {
      asked.push(q);
      const r = rows(q);
      return { totalRecords: r.length, columns: q.columns, rows: r, pages: 1, capped: false };
    },
    orderPage: async (id: string | number) => {
      const o = orders.find((x) => String(x.OrderId) === String(id));
      return o ? page(o) : "<html></html>";
    },
  } as unknown as SportsConnectClient;
  return { client, asked };
}

test("a name search re-checks every report row rather than trusting the report's filter", async () => {
  const { client, asked } = fakeClient(() => [
    { OrdersOrderId: "10", PlayersFirstName: "Sam", PlayersLastName: "Example" },
    { OrdersOrderId: "12", PlayersFirstName: "Sam", PlayersLastName: "Example" },
    { OrdersOrderId: "11", PlayersFirstName: "Alex", PlayersLastName: "Example" },
    { OrdersOrderId: "13", PlayersFirstName: "Sam", PlayersLastName: "Unrelated" },
  ]);
  const s = await findOrdersByName(client, "Sam Example", "player");
  assert.deepEqual(s.orderIds, ["12", "10"], "newest first, and only rows matching every word");
  assert.equal(asked[0].conditions[0].value, "example");
  assert.match(s.matching, /sent 4 line item\(s\); 2 matched/);
});

test("refund candidates drop rows the report sent outside the asked dates, then read each order", async () => {
  const { client } = fakeClient(
    (q) =>
      q.columns.includes("OrdersCancelOrTransferDate")
        ? [
            { OrdersOrderId: "900002", OrdersCancelOrTransferDate: "7/30/2026 12:17:44 PM" },
            { OrdersOrderId: "800000", OrdersCancelOrTransferDate: "6/1/2026 9:00:00 AM" },
          ]
        : [{ OrdersOrderId: "900002", OrderDetailUpdatedDate: "7/30/2026 12:19:02 PM" }],
    [ORDER],
  );
  const r = await findRefunds(client, "2026-07-01");
  assert.equal(r.ordersChecked, 1, "the June row was the report ignoring the condition, and is not read");
  assert.equal(r.total, 240);
  assert.equal(r.refunds[0].orderId, 900002);
  assert.match(r.candidates.OrdersCancelOrTransferDate, /2 line item\(s\) sent, 1 dated on\/after 2026-07-01/);
});

test("an order that cannot be read is reported, not dropped", async () => {
  const { client } = fakeClient(() => [
    { OrdersOrderId: "404", OrdersCancelOrTransferDate: "8/1/2026", OrderDetailUpdatedDate: "8/1/2026" },
  ]);
  const r = await findRefunds(client, "2026-07-01");
  assert.equal(r.refunds.length, 0);
  assert.equal(r.failed[0].orderId, "404");
});
