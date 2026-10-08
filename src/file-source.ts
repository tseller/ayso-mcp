/**
 * Where a tool gets the bytes of a file it is asked to attach — declared once.
 *
 * `qbo_attach_file` grew three sources (a URL the server fetches, a Gmail
 * attachment pulled server-side, and base64 as the fallback) while
 * `divvy_upload_receipt` took base64 only (issue #63). Base64 is the source
 * that costs the caller: every byte goes through the conversation as roughly
 * one output token per three bytes, so a 180 KB receipt is tens of thousands
 * of tokens just to move a file the server could have fetched itself. The
 * instance was one tool missing a parameter; the structure was that "how does
 * a tool get file bytes" was answered privately inside one tool. Both tools
 * now spread `FILE_SOURCE` into their schema and call `resolveFileSource`, so
 * an attach tool written later gets every source and the same validation.
 */
import { z } from "zod";
import type { GmailClient } from "./gmail-client.js";
import { sniffContentType } from "./mime.js";

// QBO's documented attachment ceiling is 100MB, but we buffer the whole file in
// memory on Cloud Run, so cap URL fetches well below that.
export const MAX_URL_FILE_BYTES = 30 * 1024 * 1024;

export const FILE_SOURCE_DOC =
  "Provide the file ONE of three ways: fileUrl (https URL the server fetches directly — e.g. the signed `downloadUrl` mcp-gog's gmail_get_attachment returns), gmailMessageId + gmailAttachmentId (server pulls the attachment straight from Gmail — use the Gmail MCP to find the ids), or fileBase64 (raw bytes — a fallback, since every byte then passes through the conversation). File bytes are validated by magic numbers (PDF, JPEG, PNG, GIF, WebP, HEIC) before upload.";

export const FILE_SOURCE = {
  fileUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "https URL to fetch the file from server-side (e.g. a signed attachment download link). Preferred: the bytes never pass through the conversation.",
    ),
  gmailMessageId: z
    .string()
    .optional()
    .describe("Gmail message id containing the attachment (pair with gmailAttachmentId)"),
  gmailAttachmentId: z
    .string()
    .optional()
    .describe("Gmail attachment id within the message (pair with gmailMessageId)"),
  gmailAccount: z
    .string()
    .optional()
    .describe("Gmail account email to fetch from. Optional when only one account is configured on the server."),
  fileBase64: z
    .string()
    .optional()
    .describe("Base64-encoded file bytes (image or PDF). Fallback — prefer fileUrl or the Gmail source."),
  contentType: z
    .string()
    .optional()
    .describe("Optional MIME override. Only set this if the auto-detected type is wrong."),
};

export interface FileSourceArgs {
  fileUrl?: string;
  gmailMessageId?: string;
  gmailAttachmentId?: string;
  gmailAccount?: string;
  fileBase64?: string;
  contentType?: string;
}

export interface ResolvedFile {
  data: Buffer;
  /** Which source supplied the bytes — logged and returned, never guessed. */
  source: "url" | "gmail" | "base64";
  /** The MIME to upload with: the override, else the sniffed type, else the source's. */
  mime: string;
  /** What the bytes themselves say they are (undefined only under an override). */
  sniffed?: string;
  /** A name the source offered (Content-Disposition, URL path, Gmail part). */
  fileName?: string;
}

export async function fetchFileFromUrl(
  fileUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: Buffer; contentType?: string; fileName?: string }> {
  const parsed = new URL(fileUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`fileUrl must be https (got ${parsed.protocol}//)`);
  }
  const res = await fetchImpl(fileUrl, { redirect: "follow" });
  if (!res.ok) {
    // A signed link that has expired is the likely 4xx here; say so rather
    // than leaving a bare status to decode.
    const hint =
      res.status === 400 || res.status === 403 || res.status === 404 || res.status === 410
        ? " — if this is a signed download link, it may have expired; fetch a fresh one"
        : "";
    throw new Error(`fetching fileUrl failed: ${res.status} ${res.statusText}${hint}`);
  }
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length === 0) throw new Error("fileUrl returned an empty body");
  if (data.length > MAX_URL_FILE_BYTES) {
    throw new Error(
      `fileUrl body is ${data.length} bytes, over the ${MAX_URL_FILE_BYTES}-byte limit`,
    );
  }
  const contentType = res.headers.get("content-type")?.split(";")[0].trim() || undefined;
  const disposition = res.headers.get("content-disposition") ?? "";
  const dispositionName = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const lastSegment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
  const fileName = dispositionName || (lastSegment.includes(".") ? lastSegment : undefined);
  return { data, contentType, fileName };
}

/**
 * Turn a tool's file-source arguments into validated bytes.
 *
 * Exactly one source must be named. The bytes are checked against the
 * formats a receipt can be before anything is uploaded — catching a truncated
 * transfer, an HTML error page served with a 200, or a payload that is not a
 * document at all; `contentType` is the escape hatch for a format the
 * sniffer does not know.
 */
export async function resolveFileSource(
  tool: string,
  args: FileSourceArgs,
  deps: { gmail?: GmailClient; fetchImpl?: typeof fetch } = {},
): Promise<ResolvedFile> {
  const { fileUrl, gmailMessageId, gmailAttachmentId, gmailAccount, fileBase64, contentType } = args;
  const wantsGmail = !!(gmailMessageId || gmailAttachmentId || gmailAccount);
  const sources = [!!fileBase64, !!fileUrl, wantsGmail].filter(Boolean).length;
  if (sources !== 1) {
    throw new Error(
      "provide exactly one file source — fileUrl, gmailMessageId + gmailAttachmentId, or fileBase64",
    );
  }

  let data: Buffer;
  let source: ResolvedFile["source"];
  let sourceContentType: string | undefined;
  let fileName: string | undefined;
  if (fileUrl) {
    source = "url";
    ({ data, contentType: sourceContentType, fileName } = await fetchFileFromUrl(
      fileUrl,
      deps.fetchImpl,
    ));
  } else if (wantsGmail) {
    if (!deps.gmail) {
      throw new Error(
        "the Gmail source is not configured on this server. Set GMAIL_REFRESH_TOKENS (mint tokens with `npm run gmail:link`) — or use fileUrl/fileBase64.",
      );
    }
    if (!gmailMessageId || !gmailAttachmentId) {
      throw new Error("the Gmail source needs both gmailMessageId and gmailAttachmentId");
    }
    source = "gmail";
    const fetched = await deps.gmail.getAttachment(gmailAccount, gmailMessageId, gmailAttachmentId);
    data = fetched.data;
    sourceContentType = fetched.mimeType;
    fileName = fetched.fileName;
  } else {
    source = "base64";
    data = Buffer.from(fileBase64!, "base64");
  }

  const sniffed = sniffContentType(data);
  if (!sniffed && !contentType) {
    const head = data.subarray(0, 8).toString("hex");
    throw new Error(
      `file bytes don't match any supported format (PDF, JPEG, PNG, GIF, WebP, HEIC) — source: ${source}, first bytes: ${head || "(empty)"}, size: ${data.length}. If the format is genuinely something else, pass contentType explicitly.`,
    );
  }
  if (contentType && sniffed && contentType !== sniffed) {
    console.error(`[tool] ${tool} warn=mime_mismatch override=${contentType} sniffed=${sniffed}`);
  }
  const mime = contentType || sniffed || sourceContentType || "application/octet-stream";
  return { data, source, mime, sniffed, fileName };
}
