import { test } from "node:test";
import assert from "node:assert/strict";
import { FILE_SOURCE, resolveFileSource } from "./file-source.js";
import { registerDivvyTools } from "./tools/divvy.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import type { DivvyClient } from "./divvy-client.js";
import type { QboClient } from "./qbo-client.js";
import type { GmailClient } from "./gmail-client.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n");

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** A fetch that serves `body` for one URL and records what was asked. */
function fakeFetch(body: Buffer | string, init: ResponseInit = {}) {
  const asked: string[] = [];
  const impl = (async (url: string | URL) => {
    asked.push(String(url));
    return new Response(body, init);
  }) as typeof fetch;
  return { impl, asked };
}

function registered(register: (server: unknown) => void) {
  const tools = new Map<string, { schema: Record<string, unknown>; handler: Handler }>();
  register({
    registerTool: (
      name: string,
      config: { inputSchema?: { shape?: Record<string, unknown> } },
      handler: Handler,
    ) => tools.set(name, { schema: config.inputSchema?.shape ?? {}, handler }),
  });
  return tools;
}

/**
 * The structural pin. Every tool that takes file bytes must take every
 * source — a tool that accepts base64 alone is #63's shape, where the only
 * way to attach a receipt was to paste the whole file through the
 * conversation.
 */
test("every tool that takes file bytes offers every file source", () => {
  const tools = new Map([
    ...registered((s) => registerDivvyTools(s as Parameters<typeof registerDivvyTools>[0], {} as DivvyClient)),
    ...registered((s) =>
      registerQboTransactionTools(s as Parameters<typeof registerQboTransactionTools>[0], {} as QboClient),
    ),
  ]);
  const takesBytes = [...tools].filter(([, t]) =>
    Object.keys(t.schema).some((k) => /base64/i.test(k)),
  );
  assert.deepEqual(takesBytes.map(([n]) => n).sort(), ["divvy_upload_receipt", "qbo_attach_file"]);
  for (const [name, { schema }] of takesBytes) {
    for (const key of Object.keys(FILE_SOURCE)) {
      assert.ok(key in schema, `\`${name}\` takes file bytes but does not offer \`${key}\``);
    }
  }
});

test("a fileUrl is fetched server-side and its bytes validated", async () => {
  const { impl, asked } = fakeFetch(PDF, {
    headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="receipt.pdf"' },
  });
  const file = await resolveFileSource(
    "t",
    { fileUrl: "https://storage.example/signed/abc?sig=1" },
    { fetchImpl: impl },
  );
  assert.deepEqual(asked, ["https://storage.example/signed/abc?sig=1"]);
  assert.equal(file.source, "url");
  assert.equal(file.mime, "application/pdf");
  assert.equal(file.fileName, "receipt.pdf");
  assert.deepEqual(file.data, PDF);
});

test("exactly one source is required", async () => {
  await assert.rejects(resolveFileSource("t", {}), /exactly one file source/);
  await assert.rejects(
    resolveFileSource("t", { fileUrl: "https://x.example/a.png", fileBase64: PNG.toString("base64") }),
    /exactly one file source/,
  );
});

test("a non-https fileUrl is refused before any fetch", async () => {
  const { impl, asked } = fakeFetch(PNG);
  await assert.rejects(
    resolveFileSource("t", { fileUrl: "http://169.254.169.254/x" }, { fetchImpl: impl }),
    /must be https/,
  );
  assert.equal(asked.length, 0);
});

test("an expired signed link says it may have expired", async () => {
  const { impl } = fakeFetch("expired", { status: 403, statusText: "Forbidden" });
  await assert.rejects(
    resolveFileSource("t", { fileUrl: "https://x.example/a" }, { fetchImpl: impl }),
    /403 Forbidden — if this is a signed download link, it may have expired/,
  );
});

test("an HTML page served with 200 is not uploaded as a receipt", async () => {
  const { impl } = fakeFetch("<!doctype html><p>sign in</p>", { headers: { "content-type": "text/html" } });
  await assert.rejects(
    resolveFileSource("t", { fileUrl: "https://x.example/a" }, { fetchImpl: impl }),
    /don't match any supported format .*source: url/,
  );
});

test("the Gmail source reads through the Gmail client", async () => {
  const gmail = {
    getAttachment: async (_acct: string | undefined, msg: string, att: string) => {
      assert.deepEqual([msg, att], ["m1", "a1"]);
      return { data: PNG, fileName: "AYSO Transactions.png", mimeType: "image/png", account: "x" };
    },
  } as unknown as GmailClient;
  const file = await resolveFileSource("t", { gmailMessageId: "m1", gmailAttachmentId: "a1" }, { gmail });
  assert.equal(file.source, "gmail");
  assert.equal(file.mime, "image/png");
  assert.equal(file.fileName, "AYSO Transactions.png");
});

/** The issue's own goal, end to end through the registered Divvy tool. */
test("divvy_upload_receipt attaches a receipt from a link, uploading the link's bytes", async () => {
  const calls: string[] = [];
  let uploaded: { bytes: Buffer; mime: string } | undefined;
  const client = {
    getTransaction: async () => ({ isLocked: false }),
    getReceiptUploadUrl: async () => ({ url: "https://s3.example/put-here" }),
    uploadReceiptFile: async (_url: string, bytes: Buffer, mime: string) => {
      uploaded = { bytes, mime };
    },
    attachReceiptToTransaction: async (uuid: string, url: string) => {
      calls.push(`attach ${uuid} ${url}`);
      return { ok: true };
    },
  } as unknown as DivvyClient;
  const tool = registered((s) =>
    registerDivvyTools(s as Parameters<typeof registerDivvyTools>[0], client),
  ).get("divvy_upload_receipt")!;

  const realFetch = globalThis.fetch;
  const { impl, asked } = fakeFetch(PNG, { headers: { "content-type": "image/png" } });
  globalThis.fetch = impl;
  try {
    const res = await tool.handler({ transactionUuid: "txn_1", fileUrl: "https://gog.example/dl/abc" });
    assert.ok(!res.isError, res.content[0].text);
    const out = JSON.parse(res.content[0].text);
    assert.equal(out.source, "url");
    assert.equal(out.detectedMime, "image/png");
    assert.equal(out.bytes, PNG.length);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(asked, ["https://gog.example/dl/abc"]);
  assert.deepEqual(uploaded, { bytes: PNG, mime: "image/png" });
  assert.deepEqual(calls, ["attach txn_1 https://s3.example/put-here"]);
});

test("divvy_upload_receipt still accepts the old imageBase64 argument", async () => {
  let uploaded: Buffer | undefined;
  const client = {
    getTransaction: async () => ({}),
    getReceiptUploadUrl: async () => ({ url: "https://s3.example/put-here" }),
    uploadReceiptFile: async (_u: string, bytes: Buffer) => {
      uploaded = bytes;
    },
    attachReceiptToTransaction: async () => ({}),
  } as unknown as DivvyClient;
  const tool = registered((s) =>
    registerDivvyTools(s as Parameters<typeof registerDivvyTools>[0], client),
  ).get("divvy_upload_receipt")!;
  const res = await tool.handler({ transactionUuid: "t", imageBase64: PDF.toString("base64") });
  assert.ok(!res.isError, res.content[0].text);
  assert.deepEqual(uploaded, PDF);
});
