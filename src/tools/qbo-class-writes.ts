import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { QboClient, QboError } from "../qbo-client.js";
import {
  applyClassToLines,
  diffPaths,
  isClassRefPath,
  type ClassableEntity,
  type QboLine,
} from "../class-lines.js";
import { runTool, ToolFailure } from "../tool-logging.js";
import { buildClassWriteCard, lineClassNames, type WriteCard } from "../class-write-card.js";

/**
 * Writing a Class onto existing transactions — the bulk re-tagging path.
 *
 * This is deliberately the ONLY sanctioned way to class a transaction that
 * already exists. It never sends a rebuilt line array: it fetches the
 * transaction, hands QBO's own lines to `applyClassToLines` (which deep-copies
 * them and writes exactly one property), then re-diffs the result and REFUSES
 * TO SEND if anything other than a `ClassRef` differs. A bug in this path
 * fails closed instead of quietly stripping line data off the books.
 *
 * Class tracking on this company is per line, so ClassRef goes on each line's
 * detail object; the preference is read before writing rather than assumed.
 */

const ENTITY_PATHS: Record<ClassableEntity, { get: string; post: string; wrapper: string }> = {
  Purchase: { get: "/purchase", post: "/purchase", wrapper: "Purchase" },
  Deposit: { get: "/deposit", post: "/deposit", wrapper: "Deposit" },
  JournalEntry: { get: "/journalentry", post: "/journalentry", wrapper: "JournalEntry" },
};

/**
 * The fields QBO demands back on a sparse update even though we aren't changing
 * them — omitting them is a ValidationFault, as qbo_update_purchase/deposit
 * already learned the hard way.
 */
const REQUIRED_CARRY_OVER: Record<ClassableEntity, string[]> = {
  Purchase: ["PaymentType", "AccountRef"],
  Deposit: ["DepositToAccountRef"],
  JournalEntry: ["TxnDate"],
};

interface SetClassOutcome {
  entityType: ClassableEntity;
  id: string;
  syncToken?: string;
  applied: boolean;
  dryRun: boolean;
  classId: string | null;
  linesChanged: number;
  changed: Array<{ lineId: string; from: string | null; to: string | null }>;
  skipped: Array<{ lineId: string; reason: string }>;
  diffPaths: string[];
  /** Dry run only: the same answer as an approval card (`write-card/1`), by name. */
  card?: WriteCard;
  result?: unknown;
}

/**
 * Class id → name for every class a card mentions. A line's current class
 * carries its name on QBO's own ClassRef; anything else (the target) is read
 * back from QBO. A class that cannot be read stays unnamed — the card then
 * says `class <id>` rather than guessing.
 */
async function classNamesFor(client: QboClient, lines: QboLine[], ids: Array<string | null>) {
  const names = lineClassNames(lines);
  const missing = [...new Set(ids)].filter((i): i is string => i !== null && !names.has(i));
  await Promise.all(
    missing.map(async (classId) => {
      try {
        const c = await client.getClass(classId);
        const n = c.FullyQualifiedName ?? c.Name;
        if (n) names.set(classId, n);
      } catch {
        // unnamed is the honest answer
      }
    }),
  );
  return names;
}

export async function setTransactionClass(
  client: QboClient,
  args: {
    entityType: ClassableEntity;
    id: string;
    classId?: string;
    clearClass?: boolean;
    lineIds?: string[];
    expectedSyncToken?: string;
    dryRun?: boolean;
    /** Attach the approval card to a dry run (default true; the batch tool opts out). */
    card?: boolean;
  },
): Promise<SetClassOutcome> {
  const { entityType, id, lineIds, expectedSyncToken, dryRun = false } = args;
  const classId = args.clearClass ? null : args.classId!;

  const paths = ENTITY_PATHS[entityType];
  const fetched = (await client.request("GET", `${paths.get}/${id}`)) as Record<string, unknown>;
  const existing = fetched[paths.wrapper] as (Record<string, unknown> & { Line?: QboLine[] }) | undefined;
  if (!existing) {
    throw new QboError(`${entityType} ${id} not found`, 404, fetched);
  }

  const currentToken = existing.SyncToken as string | undefined;
  if (expectedSyncToken && expectedSyncToken !== currentToken) {
    throw new QboError(
      `SyncToken mismatch on ${entityType} ${id}: you expected ${expectedSyncToken}, QuickBooks currently has ${currentToken}. ` +
        `Someone edited this transaction since you read it — re-read it before writing.`,
      409,
      { expected: expectedSyncToken, current: currentToken },
    );
  }

  const originalLines = (existing.Line ?? []) as QboLine[];
  const { lines, changed, skipped } = applyClassToLines(entityType, originalLines, classId, lineIds);

  // Self-check: the outgoing lines must differ from the incoming ones ONLY by
  // ClassRef. If anything else moved, that is a bug in this code path and we
  // refuse to write rather than damage the books.
  const differing = diffPaths(originalLines, lines);
  const offending = differing.filter((p) => !isClassRefPath(p));
  if (offending.length) {
    throw new QboError(
      `Refusing to write: the update would change fields other than ClassRef (${offending.join(", ")}). ` +
        `This is a bug — no transaction was modified.`,
      500,
      { offending },
    );
  }

  const outcome: SetClassOutcome = {
    entityType,
    id,
    syncToken: currentToken,
    applied: false,
    dryRun,
    classId,
    linesChanged: changed.length,
    changed: changed.map((c) => ({ lineId: c.lineId, from: c.from, to: c.to })),
    skipped: skipped.map((s) => ({ lineId: s.lineId, reason: s.reason })),
    diffPaths: differing,
  };

  if (dryRun && args.card !== false) {
    const ids = changed.flatMap((c) => [c.from, c.to]);
    outcome.card = buildClassWriteCard({
      entityType,
      id,
      record: existing,
      changed: outcome.changed,
      classNames: await classNamesFor(client, originalLines, [...ids, classId]),
    });
  }
  if (dryRun || changed.length === 0) return outcome;

  const update: Record<string, unknown> = {
    Id: id,
    SyncToken: currentToken,
    sparse: true,
    Line: lines,
  };
  for (const field of REQUIRED_CARRY_OVER[entityType]) {
    if (existing[field] !== undefined) update[field] = existing[field];
  }

  outcome.result = await client.request("POST", paths.post, update);
  outcome.applied = true;
  return outcome;
}

const ENTITY_ENUM = z.enum(["Purchase", "Deposit", "JournalEntry"]);

const SHARED_DESC =
  "Sets the class on an EXISTING transaction without touching anything else: it fetches the transaction, copies QuickBooks' own line array verbatim, writes only ClassRef, and re-checks that nothing else changed before sending (it refuses to write if anything else moved). This is the safe path for bulk re-tagging — do NOT use qbo_update_purchase/qbo_update_deposit's `lines` argument to add a class. Transfers are not supported because QuickBooks' Transfer entity has no lines and cannot carry a class at all.";

export function registerQboClassWriteTools(server: McpServer, client: QboClient) {
  /** Read once per process — the preference changes about never, and a fetch per line write is waste. */
  let trackingMode: Promise<"perLine" | "perTxn" | "off"> | undefined;
  const classTrackingMode = () => (trackingMode ??= client.getClassTrackingMode());

  async function guardTracking(): Promise<string | undefined> {
    const mode = await classTrackingMode();
    if (mode === "perLine") return undefined;
    if (mode === "off") {
      return "Error: class tracking is turned off for this QuickBooks company. Turn it on (Account and Settings → Advanced → Categories → Track classes) before tagging anything.";
    }
    return (
      "Error: this company tracks ONE class per transaction (ClassTrackingPerTxn), not one per line. " +
      "These tools write ClassRef onto line details, which is wrong for that setting — refusing to write. " +
      "Switch the preference to 'one to each row in transaction', or class these transactions in the QuickBooks web UI."
    );
  }

  server.registerTool(
    "qbo_set_transaction_class",
    {
      description: `Set (or clear) the Class on one existing transaction — a purchase, deposit or journal entry. ${SHARED_DESC} Use dryRun first to see exactly which lines would change; a dry run also answers \`card\`, the same change as an approval card (contract write-card/1): who, how much, and each line's class from → to by name.`,
      inputSchema: z.object({
      entityType: ENTITY_ENUM.describe("Which kind of transaction (from the list/get tools)"),
      id: z.string().describe("Transaction id"),
      classId: z
        .string()
        .optional()
        .describe("Class id to set (from qbo_list_classes). Omit and pass clearClass to remove the class instead."),
      clearClass: z
        .boolean()
        .optional()
        .describe("Remove the class from the targeted lines instead of setting one — the undo for a mis-tag"),
      lineIds: z
        .array(z.string())
        .optional()
        .describe("Only these line ids (from the get tools). Omit to class every line on the transaction."),
      expectedSyncToken: z
        .string()
        .optional()
        .describe("Fail if the transaction's SyncToken isn't this — guards against overwriting someone else's edit"),
      dryRun: z
        .boolean()
        .optional()
        .describe("Report what would change and write nothing (default false)"),
    }),
    },
    (args) =>
      runTool("qbo_set_transaction_class", args, async (a) => {
        if (!a.classId && !a.clearClass) {
          throw new Error("pass either classId (to set a class) or clearClass: true (to remove one).");
        }
        if (a.classId && a.clearClass) {
          throw new Error("classId and clearClass are contradictory — pass exactly one.");
        }
        const blocked = await guardTracking();
        if (blocked) throw new Error(blocked);

        return setTransactionClass(client, a as Parameters<typeof setTransactionClass>[1]);
      }),
  );

  server.registerTool(
    "qbo_set_transaction_class_batch",
    {
      description: `Set the Class on many existing transactions in one call — the bulk re-tagging workhorse. ${SHARED_DESC} Items run sequentially and each reports its own success or failure, so one bad item doesn't abort the rest. Run the whole batch with dryRun first, review the diff, then re-run for real.`,
      inputSchema: z.object({
      items: z
        .array(
          z.object({
            entityType: ENTITY_ENUM.describe("Which kind of transaction"),
            id: z.string().describe("Transaction id"),
            classId: z.string().optional().describe("Class id to set"),
            clearClass: z.boolean().optional().describe("Remove the class instead of setting one"),
            lineIds: z.array(z.string()).optional().describe("Only these line ids (default: all lines)"),
            expectedSyncToken: z.string().optional().describe("Guard against a concurrent edit"),
          }),
        )
        .min(1)
        .max(50)
        .describe("Transactions to re-tag, in order (max 50 per call)"),
      dryRun: z
        .boolean()
        .optional()
        .describe("Report what would change for every item and write nothing (default false)"),
    }),
    },
    (args) =>
      runTool("qbo_set_transaction_class_batch", args, async ({ items, dryRun }) => {
        const blocked = await guardTracking();
        if (blocked) throw new Error(blocked);

        const results: Array<Record<string, unknown>> = [];
      for (const [index, item] of items.entries()) {
        if (!item.classId && !item.clearClass) {
          results.push({ index, ok: false, id: item.id, error: "pass either classId or clearClass" });
          continue;
        }
        if (item.classId && item.clearClass) {
          results.push({ index, ok: false, id: item.id, error: "classId and clearClass are contradictory" });
          continue;
        }
        try {
          const outcome = await setTransactionClass(client, { ...item, dryRun, card: false });
          results.push({ index, ok: true, ...outcome, result: undefined });
        } catch (e) {
          results.push({
            index,
            ok: false,
            id: item.id,
            error: e instanceof QboError ? e.message : String(e),
          });
        }
      }

        const failed = results.filter((r) => !r.ok).length;
        const linesChanged = results.reduce((s, r) => s + (Number(r.linesChanged) || 0), 0);
        const body = {
          dryRun: dryRun ?? false,
          total: items.length,
          succeeded: items.length - failed,
          failed,
          linesChanged,
          results,
        };
        // Every item failing is data AND a failure — ToolFailure keeps the
        // per-item errors instead of collapsing them into one message.
        return failed === items.length ? new ToolFailure(body) : body;
      }),
  );
}
