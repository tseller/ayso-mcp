import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAttachmentPreview, MAX_PREVIEW_BYTES, signedUrlExpiry } from "./attachment-preview.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import type { QboClient } from "./qbo-client.js";
import { MAX_RESULT_CHARS } from "./result-size.js";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(200)]);
const S3_ERROR = Buffer.from('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>');
const SIGNED =
  "https://intuit-qbo-prod.s3.amazonaws.com/x/receipt.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261116T180000Z&X-Amz-Expires=900&X-Amz-Signature=abc";
const THUMB =
  "https://intuit-qbo-prod.s3.amazonaws.com/x/thumb.png?X-Amz-Date=20261116T180000Z&X-Amz-Expires=900";

function fetchServing(map: Record<string, Buffer | number>) {
  const asked: string[] = [];
  const impl = (async (url: string | URL) => {
    asked.push(String(url));
    const body = map[String(url)];
    if (typeof body === "number") return new Response("nope", { status: body });
    if (!body) throw new Error(`unexpected fetch ${url}`);
    return new Response(body);
  }) as typeof fetch;
  return { impl, asked };
}

test("signedUrlExpiry reads SigV4 and SigV2 expiries from the link, and guesses nothing else", () => {
  assert.equal(signedUrlExpiry(SIGNED), "2026-11-16T18:15:00.000Z");
  assert.equal(signedUrlExpiry("https://s3.example/x?Expires=1795370400"), "2026-11-22T18:00:00.000Z");
  assert.equal(signedUrlExpiry("https://s3.example/x"), undefined);
  assert.equal(signedUrlExpiry("not a url"), undefined);
});

test("an image with a QBO thumbnail is previewed inline from the thumbnail", async () => {
  const { impl, asked } = fetchServing({ [THUMB]: PNG });
  const r = await buildAttachmentPreview(
    {
      Id: "9",
      FileName: "receipt.png",
      ContentType: "image/png",
      Size: 2_000_000,
      TempDownloadUri: SIGNED,
      ThumbnailTempDownloadUri: THUMB,
      AttachableRef: [{ EntityRef: { type: "Purchase", value: "1200" } }],
    },
    impl,
  );
  assert.deepEqual(asked, [THUMB], "the 2 MB original is never fetched");
  assert.equal(r.preview?.source, "thumbnail");
  assert.equal(r.preview?.contentType, "image/png");
  assert.equal(r.preview?.dataUri, `data:image/png;base64,${PNG.toString("base64")}`);
  assert.equal(r.previewOmitted, undefined);
  assert.deepEqual(r.download, { url: SIGNED, expiresAt: "2026-11-16T18:15:00.000Z" });
  assert.deepEqual(r.attachedTo, [{ entityType: "Purchase", entityId: "1200" }]);
});

test("a PDF gets the download link and says why there is no preview, fetching nothing", async () => {
  const { impl, asked } = fetchServing({});
  const r = await buildAttachmentPreview(
    { Id: "1000000901", FileName: "r.pdf", ContentType: "application/pdf", Size: 92605, TempDownloadUri: SIGNED },
    impl,
  );
  assert.deepEqual(asked, []);
  assert.equal(r.preview, undefined);
  assert.match(r.previewOmitted!, /not an image \(application\/pdf\)/);
  assert.equal(r.download?.url, SIGNED);
});

test("a thumbnail link that serves an error page is not passed off as an image", async () => {
  const { impl } = fetchServing({ [THUMB]: S3_ERROR });
  const r = await buildAttachmentPreview(
    { Id: "9", ContentType: "image/png", TempDownloadUri: SIGNED, ThumbnailTempDownloadUri: THUMB },
    impl,
  );
  assert.equal(r.preview, undefined);
  assert.match(r.previewOmitted!, /not an image.*may have expired/);
});

test("a thumbnail link answering 403 says so", async () => {
  const { impl } = fetchServing({ [THUMB]: 403 });
  const r = await buildAttachmentPreview({ Id: "9", ContentType: "image/png", ThumbnailTempDownloadUri: THUMB }, impl);
  assert.equal(r.preview, undefined);
  assert.match(r.previewOmitted!, /answered 403/);
});

test("with no thumbnail, a small image is inlined from the original; a large one is not fetched", async () => {
  const small = fetchServing({ [SIGNED]: PNG });
  const r = await buildAttachmentPreview(
    { Id: "9", ContentType: "image/png", Size: PNG.length, TempDownloadUri: SIGNED },
    small.impl,
  );
  assert.equal(r.preview?.source, "original");

  const big = fetchServing({});
  const r2 = await buildAttachmentPreview(
    { Id: "9", ContentType: "image/jpeg", Size: MAX_PREVIEW_BYTES + 1, TempDownloadUri: SIGNED },
    big.impl,
  );
  assert.deepEqual(big.asked, []);
  assert.equal(r2.preview, undefined);
  assert.match(r2.previewOmitted!, /over the 24000-byte inline limit/);
});

test("an image bigger than the inline limit once fetched is refused, and the limit fits the tool budget", async () => {
  const huge = Buffer.concat([PNG, Buffer.alloc(MAX_PREVIEW_BYTES)]);
  const { impl } = fetchServing({ [THUMB]: huge });
  const r = await buildAttachmentPreview({ Id: "9", ContentType: "image/png", ThumbnailTempDownloadUri: THUMB }, impl);
  assert.equal(r.preview, undefined);
  assert.match(r.previewOmitted!, /inline limit/);
  // The largest preview allowed, base64'd, must leave room in the result budget.
  assert.ok(Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 < MAX_RESULT_CHARS - 2_000);
});

test("qbo_get_attachment_preview reads the Attachable by id and returns the preview", async () => {
  const tools = new Map<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  const asked: string[] = [];
  const client = {
    getAttachable: async (id: string) => {
      asked.push(id);
      return { Attachable: { Id: id, FileName: "r.pdf", ContentType: "application/pdf", TempDownloadUri: SIGNED } };
    },
  } as unknown as QboClient;
  registerQboTransactionTools(
    { registerTool: (name: string, _c: unknown, h: never) => tools.set(name, h) } as never,
    client,
  );
  const res = await tools.get("qbo_get_attachment_preview")!({ attachableId: "1000000901" });
  assert.equal(res.isError, undefined);
  const body = JSON.parse(res.content[0].text);
  assert.deepEqual(asked, ["1000000901"]);
  assert.equal(body.attachableId, "1000000901");
  assert.equal(body.download.expiresAt, "2026-11-16T18:15:00.000Z");
  assert.match(body.previewOmitted, /application\/pdf/);
});
