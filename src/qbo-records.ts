/**
 * The QuickBooks records a tool can name by id, declared once.
 *
 * `qbo_attach_file` accepted seven entity types while only two of them —
 * Purchase and Deposit — could be read back (issue #76). So a held attach on a
 * Bill could say only "bill #N": nothing could read who was paid, how much or
 * when. The two lists lived apart (an enum on one tool, two hand-written get
 * tools elsewhere) and nothing made them agree.
 *
 * Now there is one table. The attach tool's `entityType` enum is its keys, and
 * one read-only `qbo_get_*` tool is registered per entry, so a kind that can be
 * attached to can always be read. `qbo-records.test.ts` pins that against the
 * registered tools.
 */
export const QBO_RECORDS = {
  Purchase: {
    tool: "qbo_get_purchase",
    path: "purchase",
    description:
      "Get a single purchase/expense transaction by ID. Returns full details including line items.",
    idDesc: "Purchase transaction ID",
  },
  Deposit: {
    tool: "qbo_get_deposit",
    path: "deposit",
    description:
      "Get a single deposit transaction by ID. Returns full details including line items and SyncToken (needed for update_deposit).",
    idDesc: "Deposit transaction ID",
  },
  Bill: {
    tool: "qbo_get_bill",
    path: "bill",
    description:
      "Get a single bill (an amount owed to a vendor) by ID. Read-only. Returns the vendor, bill date, due date, total, balance still owed, memo and line items with their accounts and classes.",
    idDesc: "Bill ID",
  },
  Transfer: {
    tool: "qbo_get_transfer",
    path: "transfer",
    description:
      "Get a single transfer between two accounts by ID. Read-only. Returns the from account, to account, amount, date and memo. A transfer has no lines.",
    idDesc: "Transfer ID",
  },
  Invoice: {
    tool: "qbo_get_invoice",
    path: "invoice",
    description:
      "Get a single invoice (an amount a customer owes) by ID. Read-only. Returns the customer, dates, total, balance still due, memo and line items.",
    idDesc: "Invoice ID",
  },
  JournalEntry: {
    tool: "qbo_get_journal_entry",
    path: "journalentry",
    description:
      "Get a single journal entry by ID. Read-only. Returns the date, doc number, memo and every debit/credit line with its account, class and any named entity.",
    idDesc: "Journal entry ID",
  },
  VendorCredit: {
    tool: "qbo_get_vendor_credit",
    path: "vendorcredit",
    description:
      "Get a single vendor credit (a credit a vendor owes back) by ID. Read-only. Returns the vendor, date, total, balance, memo and line items.",
    idDesc: "Vendor credit ID",
  },
} as const;

export type QboRecordKind = keyof typeof QBO_RECORDS;

/** The kinds, as a non-empty tuple a zod enum accepts. */
export const QBO_RECORD_KINDS = Object.keys(QBO_RECORDS) as [QboRecordKind, ...QboRecordKind[]];
