import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { QboClient, QboError } from "../qbo-client.js";
import { FILE_SOURCE, FILE_SOURCE_DOC, resolveFileSource } from "../file-source.js";
import { IdempotencyStore, withIdempotency } from "../idempotency.js";
import type { GmailClient } from "../gmail-client.js";
import { mergeLinePatches, type LineFieldPatch, type QboLine } from "../class-lines.js";
import { runTool, ToolFailure } from "../tool-logging.js";
import {
  buildEntityList,
  queryRows,
  slimDeposit,
  slimPurchase,
  slimTransfer,
} from "../qbo-rows.js";
import { LIST_PAGING, LIST_PAGING_DOC, LIST_PAGING_NARROWING } from "./list-paging.js";

const CLASS_ID_DESC =
  "Optional Class id (the season tag, from qbo_list_classes) for this line. This company tracks one class per LINE, so it goes here rather than on the transaction.";

/**
 * Explains what a full line replace costs, so the tools can say it out loud
 * instead of letting a caller find out from their books.
 */
const REPLACE_WARNING =
  "Replacing lines discards every field the schema below cannot express — the line Id, TaxCodeRef, BillableStatus, CustomerRef and LineNum that QuickBooks put there. To change one field on an existing line, pass its lineId and only the fields you want changed; to add a class to an existing transaction, use qbo_set_transaction_class instead.";

export interface LineInput {
  lineId?: string;
  amount?: number;
  accountId?: string;
  description?: string;
  classId?: string;
  entityId?: string;
  entityType?: "Vendor" | "Customer" | "Employee";
}

/**
 * Turn a caller's `lines` argument into the array to send QBO.
 *
 * Two modes, and the caller has to pick one on purpose:
 *  - **every line carries a lineId** → edit in place. Existing lines are
 *    deep-copied and only named fields are written, so TaxCodeRef,
 *    BillableStatus, CustomerRef, LineNum and the line Id all survive.
 *  - **no line carries a lineId** → full replace, which requires
 *    `replaceAllLines: true` because it discards everything the schema can't
 *    express. It used to be the silent default; that was the bug.
 */
function buildLineUpdate(
  entityType: "Purchase" | "Deposit",
  existing: QboLine[],
  inputs: LineInput[],
  replaceAllLines: boolean,
  buildFresh: (inputs: LineInput[]) => QboLine[],
): { lines: QboLine[] } | { error: string } {
  const withIds = inputs.filter((l) => l.lineId);

  if (withIds.length && withIds.length !== inputs.length) {
    return {
      error:
        "Error: mixed line modes — some lines have a lineId and some don't. Either give every line its lineId (edit in place) or none of them (full replace with replaceAllLines: true).",
    };
  }

  if (withIds.length) {
    const patches = inputs as LineFieldPatch[];
    const { lines, unmatched } = mergeLinePatches(entityType, existing, patches);
    if (unmatched.length) {
      return {
        error: `Error: no line with id ${unmatched.join(", ")} on this transaction (it has lines ${existing
          .map((l) => l.Id)
          .filter(Boolean)
          .join(", ")}). Nothing was changed.`,
      };
    }
    return { lines };
  }

  if (!replaceAllLines) {
    return {
      error: `Error: replacing all lines needs replaceAllLines: true. ${REPLACE_WARNING}`,
    };
  }

  const incomplete = inputs.findIndex((l) => l.amount === undefined || !l.accountId);
  if (incomplete >= 0) {
    return {
      error: `Error: line ${incomplete + 1} is missing amount or accountId — both are required when replacing lines.`,
    };
  }

  return { lines: buildFresh(inputs) };
}

export function buildPurchaseLineUpdate(
  existing: QboLine[],
  inputs: LineInput[],
  replaceAllLines: boolean,
): { lines: QboLine[] } | { error: string } {
  return buildLineUpdate("Purchase", existing, inputs, replaceAllLines, (ls) =>
    ls.map((l) => {
      const detail: Record<string, unknown> = { AccountRef: { value: l.accountId } };
      if (l.classId) detail.ClassRef = { value: l.classId };
      return {
        Amount: l.amount,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: detail,
        Description: l.description,
      };
    }),
  );
}

export function buildDepositLineUpdate(
  existing: QboLine[],
  inputs: LineInput[],
  replaceAllLines: boolean,
): { lines: QboLine[] } | { error: string } {
  return buildLineUpdate("Deposit", existing, inputs, replaceAllLines, (ls) =>
    ls.map((l) => {
      const detail: Record<string, unknown> = { AccountRef: { value: l.accountId } };
      if (l.entityId) detail.Entity = { value: l.entityId, type: l.entityType ?? "Vendor" };
      if (l.classId) detail.ClassRef = { value: l.classId };
      return {
        Amount: l.amount,
        DetailType: "DepositLineDetail",
        DepositLineDetail: detail,
        Description: l.description,
      };
    }),
  );
}

export interface QboTransactionToolDeps {
  /** Enables optional idempotencyKey on the create tools. */
  idempotency?: IdempotencyStore;
  /** Enables the Gmail source on qbo_attach_file. */
  gmail?: GmailClient;
}

const IDEMPOTENCY_KEY_DESC =
  "Optional idempotency key (any unique string, e.g. a UUID per logical create). If a create with this key already succeeded, the original result is returned instead of creating a duplicate — makes retries after ambiguous 5xx errors safe.";

export function registerQboTransactionTools(
  server: McpServer,
  client: QboClient,
  deps: QboTransactionToolDeps = {},
) {
  const { idempotency, gmail } = deps;

  /** Run a create under an optional idempotency key (no-op passthrough when no store is wired). */
  async function idempotentCreate(
    tool: string,
    key: string | undefined,
    create: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!idempotency) return create();
    return withIdempotency(idempotency, tool, key, create);
  }

  server.registerTool(
    "qbo_list_purchases",
    {
      description: "List expense/purchase transactions from QuickBooks. These include credit card charges, checks, and cash purchases. Filter by date range, account, or vendor. " +
      LIST_PAGING_DOC,
      inputSchema: z.object({
      startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD"),
      accountId: z.string().optional().describe("Filter by bank/CC account ID"),
      vendorId: z.string().optional().describe("Filter by vendor (EntityRef) ID"),
      ...LIST_PAGING,
    }),
    },
    (args) =>
      runTool(
        "qbo_list_purchases",
        args,
        async ({ startDate, endDate, accountId, vendorId, startPosition, maxResults, format }) => {
          const conditions: string[] = [];
          if (startDate) conditions.push(`TxnDate >= '${startDate}'`);
          if (endDate) conditions.push(`TxnDate <= '${endDate}'`);
          if (accountId) conditions.push(`AccountRef = '${accountId}'`);
          if (vendorId) conditions.push(`EntityRef = '${vendorId}'`);
          const where = conditions.join(" AND ");
          const start = startPosition ?? 1;
          const max = maxResults ?? 100;

          const raw = await client.queryPurchases(where, start, max);
          if (format === "raw") return raw;

          const rowCount = await client.countEntities("Purchase", where);
          return buildEntityList({
            entity: "Purchase",
            key: "purchases",
            rows: queryRows(raw, "Purchase").map(slimPurchase),
            startPosition: start,
            maxResults: max,
            rowCount,
            filters: { startDate, endDate, accountId, vendorId },
          });
        },
        { narrowing: LIST_PAGING_NARROWING },
      ),
  );

  server.registerTool(
    "qbo_get_purchase",
    {
      description: "Get a single purchase/expense transaction by ID. Returns full details including line items.",
      inputSchema: z.object({
      id: z.string().describe("Purchase transaction ID"),
    }),
    },
    (args) => runTool("qbo_get_purchase", args, ({ id }) => client.getPurchase(id)),
  );

  server.registerTool(
    "qbo_update_purchase",
    {
      description: `Update a purchase transaction — categorize it by setting the expense account, vendor, class and/or memo. Sparse update: only the fields you pass are changed. The current PaymentType and AccountRef are fetched and carried over automatically (QBO rejects a sparse Purchase update without them), and SyncToken is auto-filled from the current version if omitted. Pass each line's lineId to edit that line in place, preserving every field you don't name. ${REPLACE_WARNING}`,
      inputSchema: z.object({
      id: z.string().describe("Purchase ID"),
      syncToken: z
        .string()
        .optional()
        .describe("SyncToken for optimistic locking. Omit to use the current version's token automatically."),
      vendorId: z.string().optional().describe("Set/change the vendor (EntityRef value)"),
      memo: z.string().optional().describe("Private memo/note"),
      lines: z
        .array(
          z.object({
            lineId: z
              .string()
              .optional()
              .describe(
                "Existing line Id (from qbo_get_purchase). Given, only the fields you pass are changed and everything else on that line survives. Omitted on every line, this becomes a full replace and needs replaceAllLines.",
              ),
            amount: z.number().optional().describe("Line amount (required when creating a replacement line)"),
            accountId: z
              .string()
              .optional()
              .describe("Expense account ID (required when creating a replacement line)"),
            description: z.string().optional().describe("Line description"),
            classId: z.string().optional().describe(CLASS_ID_DESC),
          }),
        )
        .optional()
        .describe("Edit lines in place by lineId, or replace all lines (see replaceAllLines)"),
      replaceAllLines: z
        .boolean()
        .optional()
        .describe(
          `Required to replace the whole line array when no lineIds are given. ${REPLACE_WARNING}`,
        ),
    }),
    },
    (args) =>
      runTool(
        "qbo_update_purchase",
        args,
        async ({ id, syncToken, vendorId, memo, lines, replaceAllLines }) => {
        // QBO rejects a sparse Purchase update without PaymentType and AccountRef
        // (ValidationFault), so fetch the current transaction and carry them over.
        const current = (await client.getPurchase(id)) as {
          Purchase?: { PaymentType?: string; AccountRef?: unknown; SyncToken?: string; Line?: QboLine[] };
        };
        const existing = current.Purchase;
        if (!existing) throw new Error(`purchase ${id} not found`);

        const update: Record<string, unknown> = {
          Id: id,
          SyncToken: syncToken ?? existing.SyncToken,
          sparse: true,
          PaymentType: existing.PaymentType,
          AccountRef: existing.AccountRef,
        };

        if (vendorId) update.EntityRef = { type: "Vendor", value: vendorId };
        if (memo) update.PrivateNote = memo;
          if (lines) {
            const built = buildPurchaseLineUpdate(existing.Line ?? [], lines, replaceAllLines ?? false);
            if ("error" in built) throw new Error(built.error.replace(/^Error: /, ""));
            update.Line = built.lines;
          }

          return client.updatePurchase(update);
        },
      ),
  );

  server.registerTool(
    "qbo_create_purchase",
    {
      description: "Create an expense/purchase transaction in QuickBooks — the outflow side (bill-pay checks, Divvy eWallet debits, Bill.com payments). Booking it into the register lets QBO's banking page offer the matching bank-feed item as a one-click Match. Provide the bank/CC account the money left, the payment type, one or more expense lines, and (for checks) the check number as docNumber.",
      inputSchema: z.object({
      paymentType: z
        .enum(["Check", "Cash", "CreditCard"])
        .describe("How it was paid: Check, Cash, or CreditCard"),
      accountId: z
        .string()
        .describe("Bank/CC account the money came out of (AccountRef value, e.g. 14 for Chase)"),
      txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD (default: today in QBO)"),
      vendorId: z.string().optional().describe("Payee vendor ID (EntityRef value)"),
      docNumber: z.string().optional().describe("Document/check number"),
      memo: z.string().optional().describe("Private note/memo"),
      lines: z
        .array(
          z.object({
            amount: z.number().describe("Line amount (positive)"),
            accountId: z.string().describe("Expense account ID (from chart of accounts)"),
            description: z.string().optional().describe("Line description"),
            classId: z.string().optional().describe(CLASS_ID_DESC),
          }),
        )
        .min(1)
        .describe("Expense lines — at least one required"),
      idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
    }),
    },
    (args) =>
      runTool("qbo_create_purchase", args, async ({ paymentType, accountId, txnDate, vendorId, docNumber, memo, lines, idempotencyKey }) => {
        const purchase: Record<string, unknown> = {
          PaymentType: paymentType,
          AccountRef: { value: accountId },
          Line: lines.map((l) => {
            const detail: Record<string, unknown> = { AccountRef: { value: l.accountId } };
            if (l.classId) detail.ClassRef = { value: l.classId };
            return {
              Amount: l.amount,
              DetailType: "AccountBasedExpenseLineDetail",
              AccountBasedExpenseLineDetail: detail,
              Description: l.description,
            };
          }),
        };
        if (txnDate) purchase.TxnDate = txnDate;
        if (vendorId) purchase.EntityRef = { type: "Vendor", value: vendorId };
        if (docNumber) purchase.DocNumber = docNumber;
        if (memo) purchase.PrivateNote = memo;

        return idempotentCreate("qbo_create_purchase", idempotencyKey, () =>
          client.createPurchase(purchase),
        );
      }),
  );

  server.registerTool(
    "qbo_list_deposits",
    {
      description: "List deposit transactions. Filter by date range. " + LIST_PAGING_DOC,
      inputSchema: z.object({
      startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD"),
      ...LIST_PAGING,
    }),
    },
    (args) =>
      runTool("qbo_list_deposits", args, async ({ startDate, endDate, startPosition, maxResults, format }) => {
        const conditions: string[] = [];
        if (startDate) conditions.push(`TxnDate >= '${startDate}'`);
        if (endDate) conditions.push(`TxnDate <= '${endDate}'`);
        const where = conditions.join(" AND ");
        const start = startPosition ?? 1;
        const max = maxResults ?? 100;

        const raw = await client.queryDeposits(where, start, max);
        if (format === "raw") return raw;

        const rowCount = await client.countEntities("Deposit", where);
        return buildEntityList({
          entity: "Deposit",
          key: "deposits",
          rows: queryRows(raw, "Deposit").map(slimDeposit),
          startPosition: start,
          maxResults: max,
          rowCount,
          filters: { startDate, endDate },
        });
      },
      { narrowing: LIST_PAGING_NARROWING },
      ),
  );

  server.registerTool(
    "qbo_get_deposit",
    {
      description: "Get a single deposit transaction by ID. Returns full details including line items and SyncToken (needed for update_deposit).",
      inputSchema: z.object({
      id: z.string().describe("Deposit transaction ID"),
    }),
    },
    (args) => runTool("qbo_get_deposit", args, ({ id }) => client.getDeposit(id)),
  );

  const depositLineSchema = z.object({
    amount: z.number().describe("Line amount (positive)"),
    accountId: z.string().describe("Income account to credit (e.g. 4005 Registration Fees)"),
    entityId: z.string().optional().describe("Attributed entity ID (customer/vendor/employee)"),
    entityType: z
      .enum(["Vendor", "Customer", "Employee"])
      .optional()
      .describe("Entity type for entityId (default Vendor)"),
    description: z.string().optional().describe("Line description"),
    classId: z.string().optional().describe(CLASS_ID_DESC),
  });
  type DepositLineInput = z.infer<typeof depositLineSchema>;

  function buildDepositLines(lines: DepositLineInput[]) {
    return lines.map((l) => {
      const detail: Record<string, unknown> = {
        AccountRef: { value: l.accountId },
      };
      // Deposit line entity is a plain ReferenceType: lowercase { value, type }.
      if (l.entityId) detail.Entity = { value: l.entityId, type: l.entityType ?? "Vendor" };
      if (l.classId) detail.ClassRef = { value: l.classId };
      return {
        Amount: l.amount,
        DetailType: "DepositLineDetail",
        DepositLineDetail: detail,
        Description: l.description,
      };
    });
  }

  function buildDeposit(item: {
    depositToAccountId: string;
    txnDate?: string;
    memo?: string;
    lines: DepositLineInput[];
  }): Record<string, unknown> {
    const deposit: Record<string, unknown> = {
      DepositToAccountRef: { value: item.depositToAccountId },
      Line: buildDepositLines(item.lines),
    };
    if (item.txnDate) deposit.TxnDate = item.txnDate;
    if (item.memo) deposit.PrivateNote = item.memo;
    return deposit;
  }

  server.registerTool(
    "qbo_create_deposit",
    {
      description: "Create a deposit transaction in QuickBooks — the inflow side (e.g. Sports Connect ACH credits into Chase). Booking it into the register lets QBO's banking page offer the matching bank-feed item as a one-click Match. Provide the deposit-to bank account and one or more lines, each crediting an income account and optionally attributing an entity (customer/vendor). For many similar deposits, prefer qbo_create_deposits_batch.",
      inputSchema: z.object({
      depositToAccountId: z
        .string()
        .describe("Bank account the funds land in (DepositToAccountRef value, e.g. 14 for Chase)"),
      txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD (default: today in QBO)"),
      memo: z.string().optional().describe("Private note/memo"),
      lines: z.array(depositLineSchema).min(1).describe("Deposit lines — at least one required"),
      idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
    }),
    },
    (args) =>
      runTool("qbo_create_deposit", args, ({ depositToAccountId, txnDate, memo, lines, idempotencyKey }) =>
        idempotentCreate("qbo_create_deposit", idempotencyKey, () =>
          client.createDeposit(buildDeposit({ depositToAccountId, txnDate, memo, lines })),
        ),
      ),
  );

  server.registerTool(
    "qbo_create_deposits_batch",
    {
      description: "Create multiple deposits in one call — each item has the same shape as qbo_create_deposit. Items run sequentially server-side and every item reports its own success/failure, so one bad item doesn't abort the rest. Give each item an idempotencyKey so the whole batch can be safely re-sent after an ambiguous network error: already-created items replay instead of duplicating.",
      inputSchema: z.object({
      deposits: z
        .array(
          z.object({
            depositToAccountId: z
              .string()
              .describe("Bank account the funds land in (DepositToAccountRef value)"),
            txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD"),
            memo: z.string().optional().describe("Private note/memo"),
            lines: z.array(depositLineSchema).min(1).describe("Deposit lines"),
            idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
          }),
        )
        .min(1)
        .max(50)
        .describe("Deposits to create, in order (max 50 per call)"),
    }),
    },
    (args) =>
      runTool("qbo_create_deposits_batch", args, async ({ deposits }) => {
        const results: Array<Record<string, unknown>> = [];
        for (const [i, item] of deposits.entries()) {
          try {
            const result = await idempotentCreate("qbo_create_deposit", item.idempotencyKey, () =>
              client.createDeposit(buildDeposit(item)),
            );
            results.push({ index: i, ok: true, result });
          } catch (e) {
            const msg = e instanceof QboError ? e.message : String(e);
            results.push({ index: i, ok: false, error: msg });
          }
        }
        const failed = results.filter((r) => !r.ok).length;
        const summary = {
          total: deposits.length,
          succeeded: deposits.length - failed,
          failed,
          results,
        };
        // Every item failed — data AND a failure, so it reports as an error
        // while still carrying each item's reason.
        return failed === deposits.length ? new ToolFailure(summary) : summary;
      }),
  );

  server.registerTool(
    "qbo_update_deposit",
    {
      description: `Update a deposit transaction — recategorize a line's income account, attributed entity and/or class, or change the memo. Parity with qbo_update_purchase. Sparse update: only the fields you pass are changed. The current DepositToAccountRef is fetched and carried over automatically (QBO requires it even in sparse updates), and SyncToken is auto-filled from the current version if omitted. Pass each line's lineId to edit that line in place, preserving every field you don't name. ${REPLACE_WARNING}`,
      inputSchema: z.object({
      id: z.string().describe("Deposit ID"),
      syncToken: z
        .string()
        .optional()
        .describe("SyncToken for optimistic locking. Omit to use the current version's token automatically."),
      depositToAccountId: z
        .string()
        .optional()
        .describe("Bank account the deposit lands in (DepositToAccountRef value). Omit to keep the current account (fetched automatically)."),
      memo: z.string().optional().describe("Private note/memo"),
      lines: z
        .array(
          z.object({
            lineId: z
              .string()
              .optional()
              .describe(
                "Existing line Id (from qbo_get_deposit). Given, only the fields you pass are changed and everything else on that line survives. Omitted on every line, this becomes a full replace and needs replaceAllLines.",
              ),
            amount: z.number().optional().describe("Line amount (required when creating a replacement line)"),
            accountId: z
              .string()
              .optional()
              .describe("Income account to credit (required when creating a replacement line)"),
            entityId: z.string().optional().describe("Attributed entity ID (customer/vendor/employee)"),
            entityType: z
              .enum(["Vendor", "Customer", "Employee"])
              .optional()
              .describe("Entity type for entityId (default Vendor)"),
            description: z.string().optional().describe("Line description"),
            classId: z.string().optional().describe(CLASS_ID_DESC),
          }),
        )
        .optional()
        .describe("Edit lines in place by lineId, or replace all lines (see replaceAllLines)"),
      replaceAllLines: z
        .boolean()
        .optional()
        .describe(
          `Required to replace the whole line array when no lineIds are given. ${REPLACE_WARNING}`,
        ),
    }),
    },
    (args) =>
      runTool(
        "qbo_update_deposit",
        args,
        async ({ id, syncToken, depositToAccountId, memo, lines, replaceAllLines }) => {
        // QBO rejects a sparse Deposit update without DepositToAccountRef
        // (ValidationFault 2020) — fetch the current txn and carry it over.
        const current = (await client.getDeposit(id)) as {
          Deposit?: { DepositToAccountRef?: unknown; SyncToken?: string; Line?: QboLine[] };
        };
        const existing = current.Deposit;
        if (!existing) throw new Error(`deposit ${id} not found`);

        const update: Record<string, unknown> = {
          Id: id,
          SyncToken: syncToken ?? existing.SyncToken,
          sparse: true,
          DepositToAccountRef: depositToAccountId
            ? { value: depositToAccountId }
            : existing.DepositToAccountRef,
        };
        if (memo) update.PrivateNote = memo;
          if (lines) {
            const built = buildDepositLineUpdate(existing.Line ?? [], lines, replaceAllLines ?? false);
            if ("error" in built) throw new Error(built.error.replace(/^Error: /, ""));
            update.Line = built.lines;
          }

          return client.updateDeposit(update);
        },
      ),
  );

  server.registerTool(
    "qbo_list_transfers",
    {
      description: "List bank transfer transactions. Filter by date range. " + LIST_PAGING_DOC,
      inputSchema: z.object({
      startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD"),
      ...LIST_PAGING,
    }),
    },
    (args) =>
      runTool("qbo_list_transfers", args, async ({ startDate, endDate, startPosition, maxResults, format }) => {
        const conditions: string[] = [];
        if (startDate) conditions.push(`TxnDate >= '${startDate}'`);
        if (endDate) conditions.push(`TxnDate <= '${endDate}'`);
        const where = conditions.join(" AND ");
        const start = startPosition ?? 1;
        const max = maxResults ?? 100;

        const raw = await client.queryTransfers(where, start, max);
        if (format === "raw") return raw;

        const rowCount = await client.countEntities("Transfer", where);
        return buildEntityList({
          entity: "Transfer",
          key: "transfers",
          rows: queryRows(raw, "Transfer").map(slimTransfer),
          startPosition: start,
          maxResults: max,
          rowCount,
          filters: { startDate, endDate },
        });
      },
      { narrowing: LIST_PAGING_NARROWING },
      ),
  );

  server.registerTool(
    "qbo_create_transfer",
    {
      description: "Create a bank transfer between two of your own accounts (e.g. Chase → Divvy payment booked as a transfer rather than a check). Moves the amount out of fromAccount and into toAccount.",
      inputSchema: z.object({
      fromAccountId: z.string().describe("Source account ID (FromAccountRef value)"),
      toAccountId: z.string().describe("Destination account ID (ToAccountRef value)"),
      amount: z.number().describe("Transfer amount (positive)"),
      txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD (default: today in QBO)"),
      memo: z.string().optional().describe("Private note/memo"),
      idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
    }),
    },
    (args) =>
      runTool("qbo_create_transfer", args, ({ fromAccountId, toAccountId, amount, txnDate, memo, idempotencyKey }) => {
        const transfer: Record<string, unknown> = {
          FromAccountRef: { value: fromAccountId },
          ToAccountRef: { value: toAccountId },
          Amount: amount,
        };
        if (txnDate) transfer.TxnDate = txnDate;
        if (memo) transfer.PrivateNote = memo;

        return idempotentCreate("qbo_create_transfer", idempotencyKey, () =>
          client.createTransfer(transfer),
        );
      }),
  );

  server.registerTool(
    "qbo_create_journal_entry",
    {
      description: "Create a journal entry — debit and credit lines that must balance (total debits = total credits). Used for adjustments like moving fall pre-collections into 2510 Deferred Registration Fees and recognizing them when the season starts. Each line specifies a posting type (Debit or Credit), an account, and optionally an attributed entity.",
      inputSchema: z.object({
      txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD (default: today in QBO)"),
      memo: z.string().optional().describe("Private note/memo"),
      lines: z
        .array(
          z.object({
            amount: z.number().describe("Line amount (positive)"),
            postingType: z.enum(["Debit", "Credit"]).describe("Debit or Credit"),
            accountId: z.string().describe("Account ID (from chart of accounts)"),
            entityId: z.string().optional().describe("Attributed entity ID (customer/vendor/employee)"),
            entityType: z
              .enum(["Vendor", "Customer", "Employee"])
              .optional()
              .describe("Entity type for entityId (default Vendor)"),
            description: z.string().optional().describe("Line description"),
            classId: z.string().optional().describe(CLASS_ID_DESC),
          }),
        )
        .min(2)
        .describe("At least two lines; total Debits must equal total Credits"),
      idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
    }),
    },
    (args) =>
      runTool("qbo_create_journal_entry", args, async ({ txnDate, memo, lines, idempotencyKey }) => {
        const totalDebit = lines
          .filter((l) => l.postingType === "Debit")
          .reduce((s, l) => s + l.amount, 0);
        const totalCredit = lines
          .filter((l) => l.postingType === "Credit")
          .reduce((s, l) => s + l.amount, 0);
        // Guard client-side so we return a clear message instead of QBO's generic fault.
        if (Math.abs(totalDebit - totalCredit) > 0.005) {
          throw new Error(
            `journal entry is unbalanced — debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}. They must be equal.`,
          );
        }

        const journalEntry: Record<string, unknown> = {
          Line: lines.map((l) => {
            const detail: Record<string, unknown> = {
              PostingType: l.postingType,
              AccountRef: { value: l.accountId },
            };
            // JournalEntry line entity nests differently from Deposit: { Type, EntityRef: { value } }.
            if (l.entityId) {
              detail.Entity = { Type: l.entityType ?? "Vendor", EntityRef: { value: l.entityId } };
            }
            if (l.classId) detail.ClassRef = { value: l.classId };
            return {
              Amount: l.amount,
              DetailType: "JournalEntryLineDetail",
              JournalEntryLineDetail: detail,
              Description: l.description,
            };
          }),
        };
        if (txnDate) journalEntry.TxnDate = txnDate;
        if (memo) journalEntry.PrivateNote = memo;

        return idempotentCreate("qbo_create_journal_entry", idempotencyKey, () =>
          client.createJournalEntry(journalEntry),
        );
      }),
  );

  server.registerTool(
    "qbo_attach_file",
    {
      description: "Attach a file (receipt, invoice, supporting doc) to a QuickBooks transaction. " + FILE_SOURCE_DOC + " Returns the created Attachable id and filename. Provide the transaction's entity type (e.g. Purchase, Deposit, Bill, Transfer) and its Id (from the list/get tools).",
      inputSchema: z.object({
      entityType: z
        .enum(["Purchase", "Deposit", "Bill", "Transfer", "Invoice", "JournalEntry", "VendorCredit"])
        .describe("QBO entity type of the transaction to attach to"),
      entityId: z.string().describe("Transaction Id (the entity's Id, from list/get tools)"),
      ...FILE_SOURCE,
      fileName: z
        .string()
        .optional()
        .describe(
          "File name to store in QBO (default: derived from the Gmail attachment or URL, else 'attachment')",
        ),
    }),
    },
    (args) =>
      runTool("qbo_attach_file", args, async ({ entityType, entityId, fileName, ...fileArgs }) => {
        const { data: fileData, source, mime, sniffed, fileName: sourceFileName } =
          await resolveFileSource("qbo_attach_file", fileArgs, { gmail });
        const name = fileName || sourceFileName || "attachment";
        console.error(
          `[tool] qbo_attach_file entityType=${entityType} entityId=${entityId} mime=${mime} sniffed=${sniffed ?? "unknown"} override=${fileArgs.contentType ?? "none"} source=${source} bytes=${fileData.length}`,
        );
        const result = await client.uploadAttachment(entityType, entityId, name, mime, fileData);
        const attachable = (
          result as {
            AttachableResponse?: Array<{ Attachable?: { Id?: string; FileName?: string } }>;
          }
        )?.AttachableResponse?.[0]?.Attachable;
        console.error(
          `[tool] qbo_attach_file step=done entityType=${entityType} entityId=${entityId} attachableId=${attachable?.Id ?? "unknown"}`,
        );
        return {
          attachableId: attachable?.Id,
          fileName: attachable?.FileName ?? name,
          contentType: mime,
          bytes: fileData.length,
          source,
          attachedTo: { entityType, entityId },
        };
      }),
  );

  server.registerTool(
    "qbo_list_attachments",
    {
      description: "List the files already attached to a QuickBooks transaction — use before qbo_attach_file to avoid duplicate uploads. Returns each attachment's Attachable id, filename, size, and content type.",
      inputSchema: z.object({
      entityType: z
        .enum(["Purchase", "Deposit", "Bill", "Transfer", "Invoice", "JournalEntry", "VendorCredit"])
        .describe("QBO entity type of the transaction"),
      entityId: z.string().describe("Transaction Id (the entity's Id, from list/get tools)"),
    }),
    },
    (args) =>
      runTool("qbo_list_attachments", args, async ({ entityType, entityId }) => {
        const result = (await client.queryAttachables(entityType, entityId)) as {
          QueryResponse?: {
            Attachable?: Array<{
              Id?: string;
              FileName?: string;
              Size?: number;
              ContentType?: string;
              Note?: string;
              MetaData?: { CreateTime?: string };
            }>;
          };
        };
        const attachments = (result.QueryResponse?.Attachable ?? []).map((a) => ({
          attachableId: a.Id,
          fileName: a.FileName,
          size: a.Size,
          contentType: a.ContentType,
          note: a.Note,
          createdAt: a.MetaData?.CreateTime,
        }));
        return { count: attachments.length, attachments };
      }),
  );
}
