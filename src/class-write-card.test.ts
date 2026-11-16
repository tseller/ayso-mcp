import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isClassRefPath, onlyClassRefChanged, type QboLine } from "./class-lines.js";
import { buildClassWriteCard, WRITE_CARD_CONTRACT, type WriteCard } from "./class-write-card.js";
import { setTransactionClass } from "./tools/qbo-class-writes.js";
import type { QboClient } from "./qbo-client.js";

/**
 * Issue #73: moving a line from one class to another was refused as
 * "touching other fields", and the dry run answered in ids a human card had
 * to re-derive. Fixtures are invented — the repository is public.
 */

// flightdeck's declared card shape, vendored from tseller/flightdeck
// contracts/write-card.json (cba1766b). The card is held to the file itself.
const contract = JSON.parse(
  readFileSync(new URL("../contracts/write-card.json", import.meta.url), "utf8"),
) as {
  contract: string;
  preview: {
    required: string[];
    properties: {
      summary: { maxLength: number };
      fields: {
        maxItems: number;
        items: { required: string[]; properties: Record<string, { type: string; maxLength?: number }> };
      };
      link: { pattern: string };
    };
  };
};

function assertMatchesContract(card: WriteCard) {
  const p = contract.preview;
  assert.equal(card.contract, contract.contract);
  for (const k of p.required) assert.ok(k in card, `card is missing \`${k}\``);
  assert.ok(card.summary.length <= p.properties.summary.maxLength, "summary too long");
  assert.match(card.link, new RegExp(p.properties.link.pattern));
  const items = p.properties.fields.items;
  assert.ok(card.fields.length >= 1 && card.fields.length <= p.properties.fields.maxItems, "field count");
  for (const f of card.fields) {
    for (const k of items.required) assert.ok(k in f, `field is missing \`${k}\``);
    for (const [k, v] of Object.entries(f)) {
      const spec = items.properties[k];
      assert.ok(spec, `field carries \`${k}\`, which the contract does not allow`);
      assert.equal(typeof v, spec.type, `field \`${k}\` is not a ${spec.type}`);
      if (spec.maxLength) assert.ok(String(v).length <= spec.maxLength, `\`${k}\` too long: ${v}`);
    }
    if (f.changed) assert.ok("from" in f, "a changed field carries `from`");
  }
}

/** A deposit whose one line is already classed — the case #73 refused. */
const classedDeposit = () => ({
  Id: "1131",
  SyncToken: "3",
  TxnDate: "2026-08-19",
  TotalAmt: 484.4,
  DepositToAccountRef: { value: "35", name: "Operating Checking" },
  Line: [
    {
      Id: "1",
      LineNum: 1,
      Amount: 484.4,
      DetailType: "DepositLineDetail",
      DepositLineDetail: {
        Entity: { value: "37", name: "Registration Processor", type: "VENDOR" },
        AccountRef: { value: "25", name: "4005 Registration Fees" },
        ClassRef: { value: "200", name: "Core:Fall 2026" },
      },
      CustomExtensions: [],
    },
  ] as QboLine[],
});

/** Just enough QboClient for setTransactionClass: one record, a class table, a POST log. */
function fakeClient(record: Record<string, unknown>, classes: Record<string, string>) {
  const posts: unknown[] = [];
  const client = {
    async request(method: string, path: string, body?: unknown) {
      if (method === "GET" && path === "/deposit/1131") return { Deposit: structuredClone(record) };
      if (method === "POST") {
        posts.push(body);
        return { Deposit: body };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async getClass(id: string) {
      if (!classes[id]) throw new Error(`Class ${id} not found`);
      return { Id: id, FullyQualifiedName: classes[id] };
    },
  };
  return { client: client as unknown as QboClient, posts };
}

// --- Goal 1: a re-class goes through; anything outside ClassRef is still refused ---

test("isClassRefPath accepts the key and paths inside it, and nothing else", () => {
  assert.ok(isClassRefPath("0.DepositLineDetail.ClassRef"));
  assert.ok(isClassRefPath("0.DepositLineDetail.ClassRef.value"));
  assert.ok(isClassRefPath("0.DepositLineDetail.ClassRef.name"));
  assert.ok(!isClassRefPath("0.DepositLineDetail.AccountRef.value"));
  assert.ok(!isClassRefPath("0.Amount"));
  assert.ok(!isClassRefPath("0.DepositLineDetail.Entity.name"));
  assert.ok(!isClassRefPath("0.DepositLineDetail.MyClassRef"), "a key merely ending in ClassRef is not one");
});

test("onlyClassRefChanged reads a re-class as class-only and an amount edit as not", () => {
  const before = classedDeposit().Line;
  const moved = structuredClone(before);
  (moved[0].DepositLineDetail as Record<string, unknown>).ClassRef = { value: "300" };
  assert.ok(onlyClassRefChanged(before, moved));

  const alsoAmount = structuredClone(moved);
  alsoAmount[0].Amount = 1;
  assert.ok(!onlyClassRefChanged(before, alsoAmount));
});

test("re-classing an already-classed line succeeds as a dry run and writes nothing", async () => {
  const { client, posts } = fakeClient(classedDeposit(), { "300": "Core:Spring 2027" });
  const out = await setTransactionClass(client, {
    entityType: "Deposit",
    id: "1131",
    classId: "300",
    dryRun: true,
  });
  assert.deepEqual(out.changed, [{ lineId: "1", from: "200", to: "300" }]);
  assert.deepEqual(out.diffPaths.sort(), [
    "0.DepositLineDetail.ClassRef.name",
    "0.DepositLineDetail.ClassRef.value",
  ]);
  assert.equal(out.applied, false);
  assert.equal(posts.length, 0);
});

test("re-classing for real sends the move and nothing but the move", async () => {
  const record = classedDeposit();
  const { client, posts } = fakeClient(record, { "300": "Core:Spring 2027" });
  const out = await setTransactionClass(client, { entityType: "Deposit", id: "1131", classId: "300" });
  assert.equal(out.applied, true);
  assert.equal(out.card, undefined, "a real write carries no preview card");
  assert.equal(posts.length, 1);
  const sent = posts[0] as { Line: QboLine[]; SyncToken: string };
  assert.equal(sent.SyncToken, "3");
  const expected = structuredClone(record.Line);
  (expected[0].DepositLineDetail as Record<string, unknown>).ClassRef = { value: "300" };
  assert.deepEqual(sent.Line, expected);
});

// --- Goal 2: the dry run answers in write-card/1, by name ---

test("a re-class dry run answers a write-card/1 card with class names, not ids", async () => {
  const { client } = fakeClient(classedDeposit(), { "300": "Core:Spring 2027" });
  const out = await setTransactionClass(client, {
    entityType: "Deposit",
    id: "1131",
    classId: "300",
    dryRun: true,
  });
  const card = out.card!;
  assertMatchesContract(card);
  assert.equal(card.contract, WRITE_CARD_CONTRACT);
  assert.equal(card.link, "https://app.qbo.intuit.com/app/deposit?txnId=1131");
  assert.deepEqual(card.fields, [
    { label: "Received from", value: "Registration Processor" },
    { label: "Deposited to", value: "Operating Checking" },
    { label: "Amount", value: "$484.40" },
    { label: "Date", value: "2026-08-19" },
    { label: "Class (line 1, $484.40)", value: "Core:Spring 2027", from: "Core:Fall 2026", changed: true },
  ]);
  assert.equal(
    card.summary,
    "Move 1 line(s) of deposit #1131 ($484.40 on 2026-08-19) to class Core:Spring 2027",
  );
});

test("clearing a class says so on the card", async () => {
  const { client } = fakeClient(classedDeposit(), {});
  const out = await setTransactionClass(client, {
    entityType: "Deposit",
    id: "1131",
    clearClass: true,
    dryRun: true,
  });
  assertMatchesContract(out.card!);
  assert.match(out.card!.summary, /^Remove the class from 1 line\(s\) of deposit #1131/);
  assert.deepEqual(out.card!.fields.at(-1), {
    label: "Class (line 1, $484.40)",
    value: "(no class)",
    from: "Core:Fall 2026",
    changed: true,
  });
});

test("a class QBO cannot name is shown by id, never guessed", async () => {
  const { client } = fakeClient(classedDeposit(), {});
  const out = await setTransactionClass(client, {
    entityType: "Deposit",
    id: "1131",
    classId: "999",
    dryRun: true,
  });
  assert.equal(out.card!.fields.at(-1)!.value, "class 999");
});

test("a many-line journal entry stays within the card's 14 fields and counts the rest", () => {
  const Line: QboLine[] = Array.from({ length: 30 }, (_, i) => ({
    Id: String(i),
    Amount: 10 + i,
    DetailType: "JournalEntryLineDetail",
    JournalEntryLineDetail: {
      PostingType: i % 2 ? "Credit" : "Debit",
      AccountRef: { value: "25", name: "4005 Registration Fees and Other Long Account Names" },
    },
  }));
  const card = buildClassWriteCard({
    entityType: "JournalEntry",
    id: "77",
    record: { Id: "77", TxnDate: "2026-09-01", TotalAmt: 1000, Line },
    changed: Line.map((l) => ({ lineId: l.Id!, from: null, to: "300" })),
    classNames: new Map([["300", "Core:Fall 2026"]]),
  });
  assertMatchesContract(card);
  assert.equal(card.fields.length, 14);
  assert.deepEqual(card.fields.at(-1), {
    label: "More lines",
    value: "19 more line(s) also move to Core:Fall 2026",
  });
  assert.equal(card.link, "https://app.qbo.intuit.com/app/journal?txnId=77");
});
