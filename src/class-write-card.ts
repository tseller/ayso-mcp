import type { ClassableEntity, QboLine } from "./class-lines.js";

/**
 * A class write's dry run, in the shape of the approval card flightdeck raises
 * when a write is held for a human (`write-card/1`, declared in
 * tseller/flightdeck `contracts/write-card.json`).
 *
 * The dry run already says WHICH lines move (`changed: [{lineId, from, to}]`),
 * but in ids. Left at that, the card has to read the record again and re-derive
 * names and amounts on its own — a second copy of "what does this write do"
 * that can drift from ours. Here the server that is about to make the write
 * says it, in the words a bookkeeper judges it by: who, how much, which
 * account, and each line's class from → to by name.
 *
 * Pure: the caller fetches the transaction and resolves class names.
 */

export const WRITE_CARD_CONTRACT = "write-card/1";

/** The contract's own limits — exceeding them makes the card fall back. */
const MAX_FIELDS = 14;
const MAX_LABEL = 40;
const MAX_VALUE = 240;
const MAX_SUMMARY = 200;

export interface WriteCardField {
  label: string;
  value: string;
  from?: string;
  changed?: boolean;
}

export interface WriteCard {
  contract: typeof WRITE_CARD_CONTRACT;
  summary: string;
  fields: WriteCardField[];
  link: string;
}

const NOUN: Record<ClassableEntity, string> = {
  Purchase: "expense",
  Deposit: "deposit",
  JournalEntry: "journal entry",
};

const PAGE: Record<ClassableEntity, string> = {
  Purchase: "expense",
  Deposit: "deposit",
  JournalEntry: "journal",
};

const NO_CLASS = "(no class)";

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

const money = (n: unknown): string | undefined =>
  typeof n === "number" && Number.isFinite(n)
    ? `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : undefined;

const refName = (ref: unknown): string | undefined => {
  const r = ref as { name?: unknown } | undefined;
  return typeof r?.name === "string" && r.name ? r.name : undefined;
};

/** The class name a line reads now, straight from QBO's own ClassRef. */
export function lineClassNames(lines: QboLine[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    for (const v of Object.values(line)) {
      const ref = (v as { ClassRef?: { value?: string; name?: string } } | null)?.ClassRef;
      if (ref?.value && ref.name) out.set(ref.value, ref.name);
    }
  }
  return out;
}

export function buildClassWriteCard(args: {
  entityType: ClassableEntity;
  id: string;
  /** The transaction as QBO returned it, before the write. */
  record: Record<string, unknown>;
  changed: Array<{ lineId: string; from: string | null; to: string | null }>;
  /** Class id → name; an id missing here is shown as `class <id>`, never guessed. */
  classNames: Map<string, string>;
}): WriteCard {
  const { entityType, id, record, changed, classNames } = args;
  const lines = (record.Line ?? []) as QboLine[];
  const name = (classId: string | null) =>
    classId === null ? NO_CLASS : classNames.get(classId) ?? `class ${classId}`;

  const header: WriteCardField[] = [];
  const push = (label: string, value: string | undefined) => {
    if (value) header.push({ label, value: clip(value, MAX_VALUE) });
  };
  if (entityType === "Purchase") {
    push("Paid to", refName(record.EntityRef));
    push("Paid from", refName(record.AccountRef));
  } else if (entityType === "Deposit") {
    const from = lines
      .map((l) => refName((l.DepositLineDetail as { Entity?: unknown } | undefined)?.Entity))
      .find(Boolean);
    push("Received from", from);
    push("Deposited to", refName(record.DepositToAccountRef));
  }
  push("Amount", money(record.TotalAmt));
  push("Date", typeof record.TxnDate === "string" ? record.TxnDate : undefined);
  if (typeof record.PrivateNote === "string") push("Memo", record.PrivateNote);

  const byId = new Map(lines.map((l) => [l.Id ?? "", l]));
  const lineFields: WriteCardField[] = changed.map((c) => {
    const line = byId.get(c.lineId);
    const amount = money(line?.Amount);
    const detail = Object.values(line ?? {}).find(
      (v) => (v as { AccountRef?: unknown } | null)?.AccountRef,
    ) as { AccountRef: unknown } | undefined;
    const account = refName(detail?.AccountRef);
    const where = [`line ${c.lineId}`, amount, entityType === "JournalEntry" ? account : undefined]
      .filter(Boolean)
      .join(", ");
    return { label: clip(`Class (${where})`, MAX_LABEL), value: name(c.to), from: name(c.from), changed: true };
  });

  // The card holds 14 fields. Header facts first, then as many lines as fit;
  // the rest are counted in one field rather than dropped without a word.
  const room = MAX_FIELDS - header.length;
  let shown = lineFields;
  if (lineFields.length > room) {
    shown = lineFields.slice(0, room - 1);
    const rest = changed.slice(room - 1);
    const targets = [...new Set(rest.map((c) => name(c.to)))].join(", ");
    shown.push({
      label: "More lines",
      value: clip(`${rest.length} more line(s) also move to ${targets}`, MAX_VALUE),
    });
  }

  const noun = NOUN[entityType];
  const total = money(record.TotalAmt);
  const facts = [total, typeof record.TxnDate === "string" ? `on ${record.TxnDate}` : undefined]
    .filter(Boolean)
    .join(" ");
  const targets = [...new Set(changed.map((c) => c.to))];
  const subject = `${noun} #${id}${facts ? ` (${facts})` : ""}`;
  const summary = !changed.length
    ? `No change: every targeted line of ${subject} already has that class`
    : targets.length === 1 && targets[0] === null
      ? `Remove the class from ${changed.length} line(s) of ${subject}`
      : `Move ${changed.length} line(s) of ${subject} to class ${targets.map(name).join(", ")}`;

  return {
    contract: WRITE_CARD_CONTRACT,
    summary: clip(summary, MAX_SUMMARY),
    fields: [...header, ...shown],
    link: `https://app.qbo.intuit.com/app/${PAGE[entityType]}?txnId=${encodeURIComponent(id)}`,
  };
}
