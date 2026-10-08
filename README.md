# ledger-match

Bank and card reconciliation for a calendar month: match every statement line to the document that
justifies it, and produce a short, honest list of the ones you could not.

```
npm install
npm run demo
npm test
```

This is the matching core of a month-end system I built for my own e-commerce company and have run
on its books every month since. The engine here is the production one; the company, suppliers,
accounts, statements and amounts are invented. The rest of that system — mailbox ingestion, the
platform APIs, the accountant's portal — is private.

## The problem

Month-end for an e-commerce business is not an accounting problem, it is a data-matching problem.

Sales sit in one system. Money arrives from payment platforms netted, fee-deducted and days late.
Supplier invoices arrive as PDFs in an inbox. The bank statement is the one place all of it
eventually meets, and nothing lines up: the references do not match, the amounts do not match
because of fees and foreign exchange, and the dates do not match because invoices are paid late and
statements are collected a month after the invoices they settle.

Reconciliation is deciding, for every line of money that moved, which document explains it.

## What the demo prints

```
  Account   Lines  Money out   Matched  Explained  No document
  bank          9   4702.12         4          4            1
  card         11    644.41         7          3            1

  2026-07-06  card     142.80  Pennine Fasteners     exact: PF-1041
  2026-07-07  bank     980.00  Northwind Marine      evidence: Statement outstanding at 30 June 2026
  2026-07-09  card      78.42  Stackhaul             foreign: SH-2291
  2026-07-11  card      60.00  Pennine Fasteners     split: PF-1058
  2026-07-12  card      35.00  Pennine Fasteners     split: PF-1058
  2026-07-15  card     219.90  Tidewater Chandlery   sum: TW-519, TW-512
  2026-07-18  card      54.00  MOORGATE ELECTRICAL   probable: MG-77
  2026-07-20  bank     761.00  Northwind Marine      statement: NM-801, NM-802, NM-803, NM-804
  2026-07-24  bank     394.80  Castleford Oils       statement: CO-311, CO-312, CO-313
  2026-07-24  bank     892.82  Castleford Oils       statement: CO-311, CO-312, CO-313
  2026-07-24  card      38.75  HARBOUR CAFE BAR      missing
  2026-07-29  bank     465.00  ASHDOWN LOGISTICS     missing
```

Twenty lines; two need a person. That last number is the output. Everything else is scaffolding.

## The six ways a line is matched

Each of these exists because the one before it was not enough, and each was added after a real
month-end went wrong in exactly that way.

**exact** — one document for the amount, within a date window. Payments are matched to documents
globally rather than line by line: with a supplier you order from weekly at the same price, a
greedy pass takes the next order's invoice and shifts every later pair by one. Pairs are ranked by
date distance across all lines at once, and a document dated *after* the payment counts half again
as far, because a bill normally precedes its payment.

**sum** — several of a supplier's documents paid together, found by subset-sum over at most three
of them.

**split** — one document paid across several lines of the same merchant within a week, which is the
same search run the other way round.

**statement** — a supplier that invoices continuously and collects once a cycle. Two things make
this safe. The cycle is modelled explicitly (`{ startDay, lag }`), so a payment is only ever matched
against the documents of the cycle it settles — a Direct Debit in September pays July's invoices,
not September's. And a *contiguous run* of documents is tried before any subset, because with
dozens of small invoices an arbitrary subset hits the target amount by coincidence often enough to
be dangerous. One statement paid in two transfers on the same day is handled as a group.

**foreign** — a purchase in another currency. Card statements truncate the figure they print —
`AMOUNT IN USD 101.` for an invoice of 101.63 — so the document total is compared as a *string
prefix*, never rounded. Where the line prints no foreign amount at all, a known supplier's invoice
is accepted only if the implied rate is plausible and the dates are within a week. That is the
weakest evidence the engine will act on, and it is deliberately hard to reach.

**evidence** — a payment tied to a document by hand, for the cases no rule can reach: the statement
of invoices outstanding before the register began. Recording that as data keeps it out of the
matching logic.

Anything still unexplained is money out with no document, and goes on the exception list with what
to do about it. Money in is a refund.

## What it refuses to do

The engine never guesses in order to raise the match rate. An unknown merchant with two candidate
invoices of the same amount is left unmatched rather than paired with the nearer one. An invoice
dated more than two weeks after a payment is never that payment's invoice. A card payment is never
treated as a supplier statement, however neatly the numbers would add up.

Those rules each cost match rate, and every one of them was added after a wrong match had to be
unpicked by hand. A wrong match is worse than no match: the exception list is checked by a person,
and a match is not.

The same principle governs the parsers. A statement whose running balance does not add up produces
a warning and the month's lines, not an exception and not silence — a mis-read row changes the
figures and nothing downstream can tell.

## Shape of the input

`reconcile()` is pure. It takes lines, documents, merchant rules and hand-tied evidence, and returns
the reconciliation. No files, no database, no network, which is what makes a month reproducible in
a test:

```ts
const result = reconcile({
  month: "2026-07",
  lines,     // BankLine[]    — from the parsers, or from anywhere
  docs,      // Doc[]         — what you were invoiced
  rules,     // MerchantRule[] — how to read a statement description
  evidence,  // BankEvidence[] — payments tied to a document by hand
  alreadyPaid, // Set<string> — documents a previous month already matched
});
```

Two parsers are included, because the messy part of this work is the input, not the algorithm:

- `parseCardStatementText` — a UK business card statement as `pdftotext -raw` renders it. Rows that
  wrap over six lines with page furniture in the middle, purchases signed the issuer's way round, a
  per-card expense statement after the closing balance that repeats the month's purchases, and a
  running balance checked line by line.
- `parseBankCsv` — the two CSV layouts a UK bank exports, columns found by name rather than
  position, and stable ids so two identical payments on the same day stay two payments.

## Tests

27 tests, `node --test`, no framework. They cover each matching strategy, each refusal, the cycle
arithmetic across a year boundary, both statement formats, a deliberately broken running balance,
CSV injection in the exception list, and one end-to-end month asserting that no document ever
justifies two unrelated payments.

## What is not here

The production system this came from also ingests supplier documents from mailboxes, pulls
settlements from the e-commerce and payment platforms, compares the result against the bookkeeping
software read-only, and publishes a pack for the accountant. That part stays private: it is
specific to one company's operations and holds its credentials and its suppliers.

If you are reviewing this as an employer and would like a walkthrough of the full system, I am happy
to do one.

MIT licensed. Node 22.18+ (TypeScript runs directly, no build step).
