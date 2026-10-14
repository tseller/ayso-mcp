# mcp-billcom

MCP (Model Context Protocol) server for the AYSO treasurer workflow, wrapping the
**QuickBooks Online** Accounting API, **BILL Divvy / Spend & Expense**, and (read-only)
**Sports Connect** registration orders.

- Entry point: `src/index.ts` — registers QBO and/or Divvy tools based on available env vars.
- Architecture, env vars, and deploy notes: see [`CLAUDE.md`](./CLAUDE.md).

## QBO tool surface

All QBO tools operate on **already-posted** register entities:

| Area | Tools |
| --- | --- |
| Accounts | `qbo_list_accounts`, `qbo_account_balances` |
| Vendors | `qbo_list_vendors`, `qbo_search_vendors`, `qbo_create_vendor` |
| Purchases | `qbo_list_purchases`, `qbo_get_purchase`, `qbo_create_purchase`, `qbo_update_purchase` |
| Deposits | `qbo_list_deposits`, `qbo_get_deposit`, `qbo_create_deposit`, `qbo_create_deposits_batch`, `qbo_update_deposit` |
| Transfers / Journal | `qbo_list_transfers`, `qbo_create_transfer`, `qbo_create_journal_entry` |
| Reports | `qbo_transaction_report`, `qbo_profit_loss`, `qbo_balance_sheet` |
| Reconcile | `qbo_reconcile_worksheet`, `qbo_cleared_transactions` |
| Attachments | `qbo_list_attachments`, `qbo_attach_file` |

## Sports Connect tool surface (read-only)

| Area | Tools |
| --- | --- |
| Orders | `sportsconnect_order_lookup` (by order id, player name or account name — status, balance, payments and refunds) |
| Refunds | `sportsconnect_refunds_since` (every refund back to a card since a date) |

## Known limitation — the QBO "For-Review" bank feed is **not** API-accessible

> **The single biggest chunk of treasurer work — the QBO _Bank transactions → For-Review_
> queue (`qbo.intuit.com/app/banking`, the "Pending" tab) — cannot be read or written by
> any tool in this MCP, because Intuit exposes no API for it.**

When a bank/card feed downloads Chase/Divvy lines, they land in the **For-Review** tab and
**do not affect the books** until a human **Adds** (categorize → post) or **Matches** them.
This staging area is what a treasurer spends most of their time in (~137 Chase lines in one
recent AYSO month).

### Why no tool can touch it

The QuickBooks Online **Accounting API (v3)** only exposes entities that are **already
posted to the register**. It has **no entity, endpoint, or OAuth scope** for downloaded /
pending / For-Review bank-feed lines. Bank feeds run through a **completely separate**
system — Intuit's **Financial Data Partner (FDP)** program over the **OFX** protocol,
intended for *financial institutions* publishing a feed *into* Intuit products, not for apps
reading a customer's review queue.

This is a deliberate, long-standing restriction. Intuit pays per-access aggregation costs
(Plaid/Yodlee/MDX) for that raw bank data and does not re-expose it through the developer
API. Intuit staff and developers have confirmed repeatedly on the developer forum that
fetching For-Review / pending bank-feed transactions via the v3 API **is not possible**.

**Sources:**
- [Intuit Developer forum — "i want to fetch bank feed pending transactions in my APP, is it possible"](https://help.developer.intuit.com/s/question/0D5TR00001JtbjS0AR/i-want-to-fetch-bank-feed-pending-trasnactions-in-my-app-is-it-possible) — answer: not accessible via the API.
- [Intuit Developer forum — "Does the API allow creating Banking Transactions into the Bank account in QB Online?"](https://help.developer.intuit.com/s/question/0D54R00008I3OROSA3/does-the-api-allow-creating-banking-transactions-into-the-bank-account-in-qb-online)
- [Apideck — How to Build a QuickBooks Bank Feed Integration Natively](https://www.apideck.com/blog/quickbooks-bank-feed-integration): *"Building a QuickBooks bank feed integration puts you into a different system than the standard QuickBooks Online API… Bank feeds in QuickBooks run through Intuit's Financial Data Partner (FDP) program and the Open Financial Exchange (OFX) protocol, completely separate from the accounting API."*
- [Top 5 QuickBooks API limitations](https://satvasolutions.medium.com/top-5-quickbooks-api-limitations-to-know-before-developing-your-qbo-app-5e76ed89bb8d) — the API exposes only accepted/recorded register transactions, not raw For-Review items.
- [Intuit App Partner Program (2025)](https://report.woodard.com/articles/intuits-app-partner-program-marks-new-phase-in-developer-ecosystem-fpwr) — the 2025 program adds tiers/fees but **no** new bank-feed read/write API surface.

### What is NOT a workaround

- **`qbo_cleared_transactions cleared=Uncleared`** returns *posted* register lines whose
  **reconcile** status is un-cleared. That is a different concept from the For-Review feed —
  those items are already in the books. It does **not** enumerate the review queue.
- **`qbo_create_purchase` / `qbo_create_deposit`** can *book* an equivalent transaction, but
  that creates a **parallel posted entity that does not clear the matching bank-feed line** →
  **double-count risk**. It is not "Add from review."

### Recommended fallbacks (until/unless Intuit ships an API)

1. **Read side — CSV/QBO export from the UI.** The For-Review list can be exported from the
   QBO banking page; feed that file to an MCP tool for read-only enumeration/triage. No API
   dependency; requires a manual export step.
2. **Write side — book-then-match.** Create the posted transaction via the MCP
   (`qbo_create_purchase` / `qbo_create_deposit`), then **Match** it to the feed line in the
   QBO UI (QBO surfaces booked entries as one-click matches — see those tools' descriptions).
   This avoids the double-count but keeps the final Add/Match a manual UI action.
3. **Attachments require a posted item first.** To attach a receipt to a For-Review item,
   **Add it in the UI first**, then use `qbo_attach_file` on the resulting posted transaction
   (exactly the path used for the $700.64 reimbursement in the source journey).
4. **Browser automation** of the QBO banking page is the only way to script Add/Match
   end-to-end; it is brittle (unofficial, UI-coupled) and out of scope for this MCP today.
5. **Bank-direct feed** (a separate Chase/Divvy → tooling pipeline) sidesteps QBO's staging
   entirely, at the cost of building and reconciling a parallel ingestion path.

**Bottom line:** enumerating or Adding/Matching the For-Review queue is **not achievable
through the QBO API**. This MCP intentionally ships no such tool; the practical path remains
UI export (read) + book-then-match (write).
