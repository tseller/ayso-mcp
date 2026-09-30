import { test } from "node:test";
import assert from "node:assert/strict";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";
import { cursorPaging } from "./tools/list-paging.js";
import {
  BILL_CURSOR_PARAM,
  BILL_MAX_PAGE_SIZE,
  BILL_PAGE_SIZE_PARAM,
  MAX_BILL_PAGES_PER_CALL,
  PAGING_SPECS,
  PagingCheck,
  billPagingLimits,
  billPagingParams,
  openCursor,
  sealCursor,
} from "./divvy-paging.js";
import type { ToolResult } from "./tool-logging.js";

/**
 * Issue #33. `divvy_list_custom_field_values` advertised `page`/`pageSize` and
 * sent them as `page`/`page_size`. BILL's v3 values endpoint reads `nextPage`
 * and `max`, and answers 200 with page one for anything else — so walking the
 * NAP-code list re-served the same 20 values behind a cursor that never moved.
 *
 * The names are fixed (#24 declared them once, src/divvy-paging.ts). These
 * tests are about the other half: that a paging parameter the backend does not
 * honor cannot be sent unnoticed. A rename fixes one wrong name; a witness is
 * what catches the next one.
 */

/** A BILL custom-field value, in the shape the live endpoint returns. */
const value = (i: number) => ({
  id: `VGFnVmFsdWU6MzAwNTAwO${String(i).padStart(3, "0")}`,
  uuid: `tvl_p5ag95f6p95gv5dhtl8a53ie${String(i).padStart(2, "0")}`,
  value: `NAP value ${i}`,
  deleted: false,
});

const values = (from: number, n: number) => Array.from({ length: n }, (_, i) => value(from + i));

/** Registers the Divvy tools against a stub and hands back what was declared. */
function registeredTools(client: unknown) {
  const tools = new Map<
    string,
    {
      schema: Record<string, unknown>;
      handler: (args: Record<string, unknown>) => Promise<ToolResult>;
    }
  >();
  const server = {
    registerTool: (
      name: string,
      config: { inputSchema?: { shape?: Record<string, unknown> } },
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => tools.set(name, { schema: config.inputSchema?.shape ?? {}, handler }),
  };
  registerDivvyTools(
    server as unknown as Parameters<typeof registerDivvyTools>[0],
    client as DivvyClient,
  );
  return tools;
}

const call = async (
  handler: (a: Record<string, unknown>) => Promise<ToolResult>,
  args: Record<string, unknown>,
) => JSON.parse((await handler(args)).content[0].text) as Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * The declaration: a knob is a pair of what BILL is asked and what is
 * asked of the answer.
 * ------------------------------------------------------------------ */

test("the paging arguments become the query parameters BILL reads, and only those", () => {
  const params = billPagingParams({ page: "YXJyYXljb25uZWN0aW9uOjE=", pageSize: "3" });
  assert.equal(params[BILL_CURSOR_PARAM], "YXJyYXljb25uZWN0aW9uOjE=");
  assert.equal(params[BILL_PAGE_SIZE_PARAM], "3");
  // The names BILL answers 200 to and ignores — #33's whole mechanism.
  for (const dead of ["page", "page_size", "pageSize", "cursor"]) {
    assert.equal(dead in params, false, `still sending \`${dead}\``);
  }
  assert.deepEqual(billPagingParams({}), { [BILL_CURSOR_PARAM]: undefined, [BILL_PAGE_SIZE_PARAM]: undefined });
});

/**
 * The structural pin, the twin of the one over `FILTER_SPECS`: a paging
 * parameter a tool offers must be declared with the BILL parameter it becomes
 * AND the question asked of the page that comes back. This is what makes
 * "sent and assumed" impossible rather than merely fixed once.
 */
test("every paging knob the tools advertise is declared with how it is witnessed", () => {
  const tools = registeredTools({});
  const cursorTools = [...tools].filter(([, { schema }]) => "page" in schema).map(([name]) => name);
  assert.ok(cursorTools.length >= 4, `expected the BILL cursor listings, found ${cursorTools}`);

  for (const name of cursorTools) {
    const { schema } = tools.get(name)!;
    const knobs = Object.keys(schema).filter((k) => k === "page" || k === "pageSize");
    assert.deepEqual(knobs.sort(), ["page", "pageSize"], `${name} advertises a partial cursor`);
    for (const knob of knobs) {
      const spec = PAGING_SPECS[knob as keyof typeof PAGING_SPECS];
      assert.ok(spec, `${name} offers \`${knob}\` with no declaration of the parameter it is sent as`);
      assert.ok(spec.param.length > 0, `\`${knob}\` is sent as nothing`);
      assert.equal(typeof spec.honored, "function", `\`${knob}\` is sent with no witness`);
    }
  }
  // And nothing is declared that no tool offers.
  const advertised = new Set(Object.keys(cursorPaging(billPagingLimits("transactions"))));
  for (const knob of Object.keys(PAGING_SPECS)) {
    assert.ok(advertised.has(knob), `PAGING_SPECS declares \`${knob}\`, which no tool offers`);
  }
});

test("a cursor carries the identity of the page it came from, and survives the round trip", () => {
  const paging = new PagingCheck();
  paging.observe([value(1), value(2)], "YXJyYXljb25uZWN0aW9uOjE=");
  const handed = paging.nextPage!;
  const opened = openCursor(handed);
  assert.equal(opened.cursor, "YXJyYXljb25uZWN0aW9uOjE=", "BILL's own cursor is what comes back");
  assert.ok(opened.fingerprint, "the page it came after is sealed onto it");

  // The seal is ours, not BILL's: what goes on the wire is BILL's cursor alone.
  assert.equal(PAGING_SPECS.page.send(handed), "YXJyYXljb25uZWN0aW9uOjE=");
  assert.equal(billPagingParams({ page: handed })[BILL_CURSOR_PARAM], "YXJyYXljb25uZWN0aW9uOjE=");
  // A bare BILL cursor pasted by hand still works; it just carries no witness.
  assert.deepEqual(openCursor("YXJyYXljb25uZWN0aW9uOjE="), { cursor: "YXJyYXljb25uZWN0aW9uOjE=" });
  assert.equal(openCursor(sealCursor("c1", "deadbeefdeadbeef")).fingerprint, "deadbeefdeadbeef");
});

/* ------------------------------------------------------------------ *
 * The symptom, reproduced: the walk that never ended.
 * ------------------------------------------------------------------ */

/** BILL as it behaved before #24: page one forever, whatever cursor it is sent. */
const stuckClient = (page1 = values(0, 3)) => {
  const asked: Array<{ page?: string; pageSize?: string }> = [];
  return {
    asked,
    listCustomFieldValues: async (_id: string, p: { page?: string; pageSize?: string } = {}) => {
      asked.push(p);
      return { results: page1, nextPage: "YXJyYXljb25uZWN0aW9uOjI=" };
    },
  };
};

test("the loop, reproduced: a cursor that re-serves its own page stops the walk and says so", async () => {
  const client = stuckClient();
  const { handler } = registeredTools(client).get("divvy_list_custom_field_values")!;

  const first = await call(handler, { customFieldId: "tty_nap", pageSize: 3 });
  assert.equal((first.values as unknown[]).length, 3);
  const cursor = first.nextPage as string;
  assert.ok(cursor, "the first page hands back a cursor");

  const second = await call(handler, { customFieldId: "tty_nap", page: cursor, pageSize: 3 });
  // The rows are ones the caller already holds. Handing them back as a new page
  // IS the loop, so they are dropped and the reason is stated.
  assert.deepEqual(second.values, []);
  assert.equal(second.nextPage, undefined, "no cursor to follow forever");
  assert.equal(second.truncatedBy, "cursor");
  const verdict = String((second.paging as Record<string, string>).page);
  assert.match(verdict, /not honored/);
  assert.match(verdict, /did not advance/);
  assert.match(verdict, new RegExp(BILL_CURSOR_PARAM));
});

test("one call cannot loop either: a stuck cursor costs two BILL pages, not ten", async () => {
  // A page size spanning several BILL pages is what used to walk the same page
  // ten times over and hand the same 50 rows back as ten pages of them.
  const txClient = {
    calls: 0,
    listTransactions: async function (p: { page?: string; pageSize?: string }) {
      this.calls += 1;
      return { results: values(0, Number(p.pageSize ?? 50)), nextPage: `fresh-cursor-${this.calls}` };
    },
  };
  const walked = await call(
    registeredTools(txClient).get("divvy_list_transactions")!.handler,
    { pageSize: 500 },
  );
  assert.equal(txClient.calls, 2, `spent ${txClient.calls} BILL calls on a stuck cursor`);
  assert.ok(txClient.calls < MAX_BILL_PAGES_PER_CALL);
  assert.equal(walked.truncatedBy, "cursor");
  assert.equal(walked.nextPage, undefined);
  assert.match(String((walked.paging as Record<string, string>).page), /did not advance/);
  // The stalled walk still hands back the rows it legitimately had.
  assert.equal(walked.returned, 50);
  assert.equal(walked.hasMore, true, "there are more rows; they just cannot be reached");
  assert.match(String(walked.note), /did not advance/);
});

/**
 * A fresh cursor string on a page already served is the case a `next === cursor`
 * comparison walks straight past — which is what `listPendingAction` and the
 * budget walker used to do.
 */
test("a page repeating one seen earlier in the same walk counts as not advancing", () => {
  const paging = new PagingCheck();
  const a = values(0, 2);
  const b = values(2, 2);
  assert.equal(paging.observe(a, "cursor-b").length, 2);
  assert.equal(paging.observe(b, "cursor-a").length, 2);
  // BILL cycles back: a new cursor string, a page we already hold.
  assert.equal(paging.observe(a, "cursor-b").length, 0);
  assert.equal(paging.looped, true);
  assert.equal(paging.hasMore, false);
  assert.equal(paging.nextPage, undefined);
});

/* ------------------------------------------------------------------ *
 * The fix, end to end: the walk terminates and visits each value once.
 * ------------------------------------------------------------------ */

/** BILL's values endpoint, honestly paged: `max` rows from `nextPage`. */
function valuesClient(total: number) {
  const asked: Array<{ page?: string; pageSize?: string }> = [];
  return {
    asked,
    listCustomFieldValues: async (_id: string, p: { page?: string; pageSize?: string } = {}) => {
      asked.push(p);
      const from = p.page ? Number(p.page) : 0;
      const n = Math.max(0, Math.min(Number(p.pageSize ?? 20), total - from));
      return {
        results: values(from, n),
        nextPage: from + n < total ? String(from + n) : undefined,
      };
    },
  };
}

test("walking a custom field's values reaches the end, visiting each value exactly once", async () => {
  const client = valuesClient(72);
  const { handler } = registeredTools(client).get("divvy_list_custom_field_values")!;

  const seen: string[] = [];
  let cursor: string | undefined;
  let calls = 0;
  for (;;) {
    const result = await call(handler, { customFieldId: "tty_nap", pageSize: 10, page: cursor });
    calls += 1;
    for (const row of result.values as Array<{ uuid: string }>) seen.push(row.uuid);
    cursor = result.nextPage as string | undefined;
    assert.ok(calls <= 12, "the walk did not terminate");
    if (!cursor) break;
  }

  assert.equal(calls, 8, "72 values at 10 a page");
  assert.equal(seen.length, 72);
  assert.equal(new Set(seen).size, 72, "every value exactly once");
  // BILL's own cursor went out on every request after the first, seal stripped.
  assert.deepEqual(client.asked[1], { page: "10", pageSize: "10" });
});

test("the whole list in one call is the default, at BILL's own page maximum", async () => {
  const client = valuesClient(72);
  const { handler } = registeredTools(client).get("divvy_list_custom_field_values")!;
  const result = await call(handler, { customFieldId: "tty_nap" });
  assert.equal((result.values as unknown[]).length, 72);
  assert.equal(result.nextPage, undefined, "the list ended");
  assert.deepEqual(client.asked, [
    { page: undefined, pageSize: String(BILL_MAX_PAGE_SIZE.customFieldValues) },
  ]);
  // Nothing was witnessed as wrong, and the caller turned no knob, so the
  // result carries no verdict rather than a sentence about paging that worked.
  assert.equal(result.paging, undefined);
});

/* ------------------------------------------------------------------ *
 * The verdicts, one at a time.
 * ------------------------------------------------------------------ */

test("a page size BILL ignores is reported, not assumed", () => {
  const ignored = new PagingCheck({ pageSize: "3" });
  // BILL's default page of 20, whatever `max` said — the #24 symptom.
  ignored.observe(values(0, 20), "c2", "3");
  assert.match(String(ignored.report()!.pageSize), /not honored/);
  assert.match(String(ignored.report()!.pageSize), /at most 3 row\(s\) a page as `max` and it returned 20/);

  const honored = new PagingCheck({ pageSize: "3" });
  honored.observe(values(0, 3), "c2", "3");
  assert.match(String(honored.report()!.pageSize), /^server — sent as `max`/);
});

test("a page size the caller never asked for is not reported unless BILL overran it", () => {
  const quiet = new PagingCheck();
  quiet.observe(values(0, 50), "c2", "50");
  assert.equal(quiet.report(), undefined, "no knob turned, no verdict claimed");

  const overrun = new PagingCheck();
  overrun.observe(values(0, 80), "c2", "50");
  assert.match(String(overrun.report()!.pageSize), /not honored/);
});

test("a cursor this tool did not issue says so rather than claiming it advanced", () => {
  const paging = new PagingCheck({ page: "YXJyYXljb25uZWN0aW9uOjE=" });
  paging.observe(values(0, 2), "c2");
  assert.equal(paging.looped, false);
  assert.match(String(paging.report()!.page), /not issued by this tool/);
  assert.match(String(paging.report()!.page), /could not be witnessed/);
});

test("with a healthy cursor the walk reports advancing, and hands one back", () => {
  const paging = new PagingCheck({ page: sealCursor("c1", "deadbeefdeadbeef") });
  paging.observe(values(0, 2), "c2");
  assert.equal(paging.looped, false);
  assert.match(String(paging.report()!.page), /^server — sent as `nextPage`/);
  assert.equal(openCursor(paging.nextPage!).cursor, "c2");
});

test("an empty page witnesses nothing about the cursor — BILL does end a list with one", () => {
  const paging = new PagingCheck({ page: sealCursor("c1", "deadbeefdeadbeef") });
  assert.deepEqual(paging.observe([], undefined), []);
  assert.equal(paging.looped, false, "an empty last page is not a loop");
  assert.equal(paging.hasMore, false);
});

/* ------------------------------------------------------------------ *
 * The other two walkers, which had the same hole.
 * ------------------------------------------------------------------ */

test("the pending-action walk stops on a re-served page, not only on a repeated cursor string", async () => {
  const client = new DivvyClient("test-token");
  const requests: URL[] = [];
  const real = globalThis.fetch;
  let served = 0;
  globalThis.fetch = (async (input: string | URL) => {
    requests.push(new URL(String(input)));
    served += 1;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      // The same page every time, under a cursor string that always changes —
      // which the old `next === cursor` check could not see.
      json: async () => ({
        results: [
          {
            id: "t1",
            uuid: "txr_1",
            status: "PENDING",
            occurredTime: "2026-05-02T10:00:00.000+00:00",
            receiptRequired: true,
            receiptStatus: "MISSING",
            customFields: [],
          },
        ],
        nextPage: `fresh-${served}`,
      }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const pending = await client.listPendingAction();
    assert.equal(requests.length, 2, `walked ${requests.length} BILL pages on a stuck cursor`);
    assert.equal(
      pending.pendingFields.length,
      1,
      "the same transaction was bucketed once, not once per page",
    );
  } finally {
    globalThis.fetch = real;
  }
});
