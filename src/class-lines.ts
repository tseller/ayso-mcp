/**
 * Setting a Class on an existing transaction's lines — WITHOUT rebuilding them.
 *
 * Why this module exists at all:
 *
 * The obvious way to add a class to an existing transaction is to send the
 * update tools a `lines` array with the class on it. That is a trap. Those
 * arrays can express three fields (amount, account, description); a real line
 * in the AYSO books carries up to seven. Measured live across the 389 lines on
 * the 337 transactions since 2026-01-01: every purchase line carries `Id`,
 * `Description`, `TaxCodeRef` AND `BillableStatus` (some also `CustomerRef`),
 * every deposit line carries `Id` + `LineNum` (85 of 91 also `Entity`), every
 * journal-entry line carries `Id` (94 of 100 also `Entity`). Rebuilding lines
 * from a 3-field schema silently throws the rest away.
 *
 * So nothing here rebuilds a line. `applyClassToLines` deep-copies the lines
 * QBO just gave us and writes exactly one property — `ClassRef` — leaving
 * every other byte alone. `diffPaths` exists so that claim is *checkable*
 * rather than merely asserted: the tests (and the tools' own dryRun output)
 * diff the outgoing payload against the incoming one and require that the only
 * paths that differ end in `ClassRef`.
 *
 * Class tracking on this company is PER LINE (`ClassTrackingPerTxnLine: true`,
 * verified live), which is why ClassRef goes on each line's detail object and
 * never on the transaction header.
 */

export type ClassableEntity = "Purchase" | "Deposit" | "JournalEntry";

/**
 * The line-detail objects that can carry a ClassRef, per entity type.
 *
 * A Purchase can hold both account-based and item-based expense lines; both
 * take a ClassRef. Anything else on a transaction (a discount line, say) is
 * skipped and reported rather than silently ignored.
 */
export const CLASSABLE_DETAIL_KEYS: Record<ClassableEntity, string[]> = {
  Purchase: ["AccountBasedExpenseLineDetail", "ItemBasedExpenseLineDetail"],
  Deposit: ["DepositLineDetail"],
  JournalEntry: ["JournalEntryLineDetail"],
};

export interface QboLine {
  Id?: string;
  LineNum?: number;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  [key: string]: unknown;
}

export interface LineClassChange {
  lineId: string;
  detailType: string;
  from: string | null;
  to: string | null;
}

export interface LineClassSkip {
  lineId: string;
  detailType: string;
  reason: string;
}

export interface ApplyClassResult {
  /** A deep copy of the input lines with ClassRef applied. Never a rebuild. */
  lines: QboLine[];
  changed: LineClassChange[];
  /** Lines left untouched, each with the reason — never silently dropped. */
  skipped: LineClassSkip[];
}

const detailOf = (line: QboLine, keys: string[]): { key: string; detail: Record<string, unknown> } | undefined => {
  for (const key of keys) {
    const d = line[key];
    if (d && typeof d === "object") return { key, detail: d as Record<string, unknown> };
  }
  return undefined;
};

const classRefValue = (detail: Record<string, unknown>): string | null => {
  const ref = detail.ClassRef as { value?: string } | undefined;
  return ref?.value ?? null;
};

/**
 * Return a deep copy of `lines` with `ClassRef` set (or cleared) on the
 * targeted lines, and nothing else touched.
 *
 * @param lineIds  restrict to these line Ids; omit for every classable line
 * @param classId  the Class id to set, or `null` to remove the class
 */
export function applyClassToLines(
  entityType: ClassableEntity,
  lines: QboLine[],
  classId: string | null,
  lineIds?: string[],
): ApplyClassResult {
  const keys = CLASSABLE_DETAIL_KEYS[entityType];
  const wanted = lineIds?.length ? new Set(lineIds) : undefined;
  const copy = structuredClone(lines) as QboLine[];
  const changed: LineClassChange[] = [];
  const skipped: LineClassSkip[] = [];

  for (const line of copy) {
    const lineId = line.Id ?? "";
    const detailType = line.DetailType ?? "";

    if (wanted && !wanted.has(lineId)) {
      skipped.push({ lineId, detailType, reason: "not in lineIds" });
      continue;
    }

    const found = detailOf(line, keys);
    if (!found) {
      skipped.push({
        lineId,
        detailType,
        reason: `line detail cannot carry a class (expected one of: ${keys.join(", ")})`,
      });
      continue;
    }

    const from = classRefValue(found.detail);
    if (from === classId) {
      skipped.push({ lineId, detailType, reason: "already set to this class" });
      continue;
    }

    if (classId === null) {
      delete found.detail.ClassRef;
    } else {
      found.detail.ClassRef = { value: classId };
    }
    changed.push({ lineId, detailType, from, to: classId });
  }

  if (wanted) {
    const present = new Set(copy.map((l) => l.Id ?? ""));
    for (const id of wanted) {
      if (!present.has(id)) {
        skipped.push({ lineId: id, detailType: "", reason: "no such line on this transaction" });
      }
    }
  }

  return { lines: copy, changed, skipped };
}

/** A partial edit to one existing line, addressed by its line id. */
export interface LineFieldPatch {
  lineId: string;
  amount?: number;
  accountId?: string;
  description?: string;
  classId?: string;
  entityId?: string;
  entityType?: string;
}

/**
 * Merge field-level edits into existing lines, addressed by line id.
 *
 * This is the structural fix behind `qbo_update_purchase` / `qbo_update_deposit`:
 * those tools used to rebuild every line from a 3-field schema, so any field
 * they couldn't express — `TaxCodeRef`, `BillableStatus`, `CustomerRef`,
 * `LineNum`, the line `Id` itself — was silently dropped on every update. Here
 * the existing lines are deep-copied and only the named fields are written, so
 * an edit costs exactly what it says it costs. Lines nobody mentions are
 * carried through untouched.
 */
export function mergeLinePatches(
  entityType: ClassableEntity,
  existing: QboLine[],
  patches: LineFieldPatch[],
): { lines: QboLine[]; merged: string[]; unmatched: string[] } {
  const keys = CLASSABLE_DETAIL_KEYS[entityType];
  const lines = structuredClone(existing) as QboLine[];
  const byId = new Map(lines.map((l) => [l.Id ?? "", l]));
  const merged: string[] = [];
  const unmatched: string[] = [];

  for (const patch of patches) {
    const line = byId.get(patch.lineId);
    if (!line) {
      unmatched.push(patch.lineId);
      continue;
    }
    if (patch.amount !== undefined) line.Amount = patch.amount;
    if (patch.description !== undefined) line.Description = patch.description;

    const found = detailOf(line, keys);
    if (found) {
      if (patch.accountId !== undefined) found.detail.AccountRef = { value: patch.accountId };
      if (patch.classId !== undefined) found.detail.ClassRef = { value: patch.classId };
      if (patch.entityId !== undefined) {
        found.detail.Entity = { value: patch.entityId, type: patch.entityType ?? "Vendor" };
      }
    }
    merged.push(patch.lineId);
  }

  return { lines, merged, unmatched };
}

/**
 * Every path at which two JSON values differ, as dotted paths
 * (e.g. `0.AccountBasedExpenseLineDetail.ClassRef`).
 *
 * This is the proof instrument for the whole module: if a class write ever
 * starts dropping line data, a path that does not end in `ClassRef` shows up
 * here and both the tests and the tools' dryRun output say so.
 */
export function diffPaths(before: unknown, after: unknown, path = ""): string[] {
  if (before === after) return [];

  const bothObjects =
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after);

  if (!bothObjects) return [path];

  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: string[] = [];
  for (const k of keys) {
    const child = path ? `${path}.${k}` : k;
    if (!(k in b) || !(k in a)) {
      out.push(child);
      continue;
    }
    out.push(...diffPaths(b[k], a[k], child));
  }
  return out;
}

/**
 * True when a `diffPaths` path lies at or INSIDE a ClassRef — the one place a
 * class write may change anything.
 *
 * Inside matters: setting a class where there was none differs at
 * `0.DepositLineDetail.ClassRef` (the key is new), but moving a line from one
 * class to another keeps the key and differs at `…ClassRef.value` and
 * `…ClassRef.name`. A test for "ends in ClassRef" refused the commonest
 * re-tagging case as touching other fields (issue #73). This is the only copy
 * of the rule; the write tools' self-check and `onlyClassRefChanged` both ask it.
 */
export function isClassRefPath(path: string): boolean {
  return path.split(".").includes("ClassRef");
}

/** True when every difference is a ClassRef — i.e. no line data was disturbed. */
export function onlyClassRefChanged(before: unknown, after: unknown): boolean {
  const paths = diffPaths(before, after);
  return paths.length > 0 && paths.every(isClassRefPath);
}
