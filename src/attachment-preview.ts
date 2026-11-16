/**
 * A preview of a file attached to a QuickBooks record — small enough to show
 * on a card, honest about when it cannot be shown.
 *
 * `qbo_list_attachments` names a record's files but hands back no bytes and no
 * link, so nothing downstream could show one (tseller/ayso-mcp#71). QBO's own
 * Attachable carries what is needed: `TempDownloadUri` (a signed link to the
 * file) and, for an image, `ThumbnailTempDownloadUri` (a signed link to a
 * small rendition). Both are short-lived.
 *
 * Two choices worth knowing:
 *
 *  - The preview is returned **inline** as a `data:` URI, not as a link. A
 *    signed link expires minutes after it is minted, so a card that held one
 *    would show a broken image to anyone who opened it later. The bytes do not
 *    expire.
 *  - The link's expiry is **read from the link** (the signature's own
 *    `X-Amz-Date` + `X-Amz-Expires`, or a v2 `Expires`), not assumed. A link
 *    whose expiry cannot be read says so rather than inventing one.
 *
 * Whatever is inlined is sniffed first: a signed link that has expired, or a
 * storage error page served with a 200, is not an image, and a card must not
 * be handed one as if it were.
 */

import { sniffContentType } from "./mime.js";

/**
 * The largest image inlined, in bytes. Base64 is 4/3 the size, so this keeps
 * the whole result (~32k chars of preview) under the 40k-char tool budget
 * with room for the rest of the answer.
 */
export const MAX_PREVIEW_BYTES = 24_000;

/** The Attachable fields this reads. */
export interface AttachableLike {
  Id?: string;
  FileName?: string;
  ContentType?: string;
  Size?: number;
  TempDownloadUri?: string;
  ThumbnailTempDownloadUri?: string;
  AttachableRef?: Array<{ EntityRef?: { type?: string; value?: string } }>;
}

export interface AttachmentPreview {
  attachableId?: string;
  fileName?: string;
  contentType?: string;
  size?: number;
  attachedTo?: Array<{ entityType?: string; entityId?: string }>;
  /** A signed link to the whole file, and when it stops working. */
  download?: { url: string; expiresAt?: string; note?: string };
  /** An image small enough to show, inline. */
  preview?: {
    source: "thumbnail" | "original";
    contentType: string;
    bytes: number;
    dataUri: string;
  };
  /** Why there is no `preview`, in words. Present exactly when `preview` is not. */
  previewOmitted?: string;
}

/**
 * When a signed link stops working, read from the link itself. SigV4 carries
 * `X-Amz-Date` (YYYYMMDDTHHMMSSZ) and `X-Amz-Expires` (seconds); SigV2 carries
 * `Expires` (epoch seconds). Anything else → undefined, never a guess.
 */
export function signedUrlExpiry(url: string): string | undefined {
  let q: URLSearchParams;
  try {
    q = new URL(url).searchParams;
  } catch {
    return undefined;
  }
  const amzDate = q.get("X-Amz-Date");
  const amzExpires = q.get("X-Amz-Expires");
  if (amzDate && amzExpires) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
    const secs = Number(amzExpires);
    if (m && Number.isFinite(secs)) {
      const signed = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      return new Date(signed + secs * 1000).toISOString();
    }
  }
  const v2 = q.get("Expires");
  if (v2 && /^\d+$/.test(v2)) return new Date(Number(v2) * 1000).toISOString();
  return undefined;
}

/** Fetch a signed link's bytes; a failure is a sentence, not a throw. */
async function fetchSigned(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ data: Buffer } | { error: string }> {
  try {
    const res = await fetchImpl(url, { redirect: "follow" });
    if (!res.ok) return { error: `QBO's signed link answered ${res.status}` };
    return { data: Buffer.from(await res.arrayBuffer()) };
  } catch (e) {
    return { error: `QBO's signed link could not be fetched (${e instanceof Error ? e.message : e})` };
  }
}

/**
 * Inline `data` as the preview if it really is an image and small enough;
 * otherwise say why not.
 */
function inline(
  data: Buffer,
  source: "thumbnail" | "original",
): { preview: NonNullable<AttachmentPreview["preview"]> } | { omitted: string } {
  const sniffed = sniffContentType(data);
  if (!sniffed || !sniffed.startsWith("image/")) {
    return {
      omitted: `QBO's ${source} link returned ${data.length} bytes that are not an image (${sniffed ?? "unrecognised format"}) — the link may have expired`,
    };
  }
  if (data.length > MAX_PREVIEW_BYTES) {
    return {
      omitted: `the ${source} is ${data.length} bytes, over the ${MAX_PREVIEW_BYTES}-byte inline limit — use download.url`,
    };
  }
  return {
    preview: {
      source,
      contentType: sniffed,
      bytes: data.length,
      dataUri: `data:${sniffed};base64,${data.toString("base64")}`,
    },
  };
}

/**
 * Build the preview for one Attachable. Prefers QBO's own thumbnail; falls
 * back to the original only when it is an image already small enough to show.
 * A PDF or other document gets the download link and no preview.
 */
export async function buildAttachmentPreview(
  a: AttachableLike,
  fetchImpl: typeof fetch = fetch,
): Promise<AttachmentPreview> {
  const out: AttachmentPreview = {
    attachableId: a.Id,
    fileName: a.FileName,
    contentType: a.ContentType,
    size: a.Size,
  };
  const refs = (a.AttachableRef ?? [])
    .map((r) => ({ entityType: r.EntityRef?.type, entityId: r.EntityRef?.value }))
    .filter((r) => r.entityType || r.entityId);
  if (refs.length) out.attachedTo = refs;

  if (a.TempDownloadUri) {
    const expiresAt = signedUrlExpiry(a.TempDownloadUri);
    out.download = expiresAt
      ? { url: a.TempDownloadUri, expiresAt }
      : { url: a.TempDownloadUri, note: "QBO's signed link; its expiry could not be read from it, so treat it as short-lived" };
  }

  if (a.ThumbnailTempDownloadUri) {
    const got = await fetchSigned(a.ThumbnailTempDownloadUri, fetchImpl);
    if ("error" in got) out.previewOmitted = got.error;
    else {
      const r = inline(got.data, "thumbnail");
      if ("preview" in r) out.preview = r.preview;
      else out.previewOmitted = r.omitted;
    }
    return out;
  }

  const type = a.ContentType ?? "unknown type";
  if (!type.startsWith("image/")) {
    out.previewOmitted = `not an image (${type}) — QBO makes thumbnails for images only; use download.url`;
    return out;
  }
  if (!a.TempDownloadUri) {
    out.previewOmitted = "QBO returned no thumbnail and no download link for this image";
    return out;
  }
  if (typeof a.Size === "number" && a.Size > MAX_PREVIEW_BYTES) {
    out.previewOmitted = `QBO returned no thumbnail, and the image is ${a.Size} bytes, over the ${MAX_PREVIEW_BYTES}-byte inline limit — use download.url`;
    return out;
  }
  const got = await fetchSigned(a.TempDownloadUri, fetchImpl);
  if ("error" in got) out.previewOmitted = got.error;
  else {
    const r = inline(got.data, "original");
    if ("preview" in r) out.preview = r.preview;
    else out.previewOmitted = r.omitted;
  }
  return out;
}
