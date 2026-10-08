/**
 * The shapes the matcher works with. Everything here is plain data: the engine
 * never reads a file or a database, so a month can be reconciled from literals
 * in a test.
 */

/** Which account a line came from. The engine only cares that cards and bank accounts behave differently. */
export type AccountKind = "card" | "bank";

export interface BankLine {
  /** Stable across re-imports of the same statement: account, date, balance, amount. */
  id: string;
  account: AccountKind;
  /** Cleared date, YYYY-MM-DD. */
  date: string;
  /** When the card authorised the payment, if the statement prints it. Matching prefers this date. */
  authorisedDate: string | null;
  type: string;
  description: string;
  /** Signed from the company's point of view: money out negative, money in positive. */
  amount: number;
  balance: number | null;
  currency: "GBP";
  /** Statement file the line was read from, and where it lives. */
  source: string;
  path: string;
}

export interface MerchantRule {
  /** Case-insensitive regex against the statement description. First rule that matches wins. */
  match: string;
  supplier: string;
  /** Supplier keys from the document register that this merchant may be matched against. */
  keys?: string[];
  /**
   * supplier  = a purchase that needs a document
   * transfer  = money between the company's own accounts
   * internal  = the statement line is its own evidence (interest, rewards, bank charges)
   * platform  = a payout or fee already covered by a platform settlement
   */
  kind: "supplier" | "transfer" | "internal" | "platform";
  /** What to do when no document is found. Printed on the exception list. */
  action?: string;
  note?: string;
  /**
   * Suppliers that invoice continuously and collect once per cycle. Cycles start on `startDay`
   * of each month, and a payment settles the cycle `lag` cycles before the one it falls in.
   * Northwind Marine bills 6th to 5th and collects the next cycle (lag 1); Castleford Oils bills
   * by calendar month and collects two cycles later, so its "JULY" Direct Debit on 2 September
   * pays the June invoices (lag 2).
   */
  cycle?: { startDay: number; lag: number };
}

export interface Doc {
  id: string;
  /** Join key to the merchant rule; one supplier may trade under several statement descriptions. */
  supplierKey: string;
  supplier: string;
  kind: string;
  number: string | null;
  date: string;
  /** Signed like a payment: purchases positive, credit notes negative. */
  total: number;
  currency: string;
  file: string | null;
  month: string;
  /**
   * A document from a secondary source rather than the register (a platform's own billing export).
   * Usable for matching, but never listed as "issued this month and unpaid".
   */
  fallback?: boolean;
}

export interface LineMatch {
  docId: string;
  supplier: string;
  kind: string;
  number: string | null;
  date: string;
  total: number;
  file: string | null;
  /**
   * exact     = one document for the amount
   * sum       = several documents paid together
   * split     = one document paid across several lines
   * statement = a run of documents settled by one cycle payment
   * foreign   = the document is in another currency and matched the foreign amount on the line
   * probable  = amount and date agree but the merchant has no rule
   * evidence  = tied to the payment by hand, because no document can be matched automatically
   */
  how: "exact" | "sum" | "split" | "statement" | "foreign" | "probable" | "evidence";
  /** The document's currency when it is not sterling; `total` is then in that currency. */
  currency?: string;
}

export type LineStatus = "matched" | "missing" | "transfer" | "internal" | "platform" | "refund" | "credit";

export interface ReconciledLine extends BankLine {
  merchant: string;
  ruleKind: MerchantRule["kind"] | "unknown";
  status: LineStatus;
  matches: LineMatch[];
  /** For a line with no document: what a person should do about it. */
  action: string | null;
  note: string | null;
  /** Where the document may be hiding, if a hint source was supplied. */
  hints: string[];
}

/**
 * A payment tied by hand to the document that justifies it, for the cases the register cannot
 * cover — typically a statement settling invoices issued before the register starts.
 */
export interface BankEvidence {
  account: AccountKind;
  date: string;
  /** Money out, positive. */
  amount: number;
  supplier: string;
  document: string;
  file?: string;
  note?: string;
}

export interface AccountSummary {
  account: AccountKind;
  lines: number;
  moneyOut: number;
  moneyIn: number;
  matched: number;
  matchedAmount: number;
  missing: number;
  missingAmount: number;
  /** Lines that need no document: transfers, internal charges, platform payouts, refunds. */
  explained: number;
  statements: { source: string; path: string }[];
}

export interface MonthReconciliation {
  month: string;
  accounts: AccountSummary[];
  lines: ReconciledLine[];
  /** The exception list: money out with no document. This is the output a person acts on. */
  missing: ReconciledLine[];
  /** Documents issued this month that no loaded account paid. */
  unpaidDocs: (Doc & { hint: string })[];
  notes: string[];
}

export interface ReconcileInput {
  month: string;
  lines: BankLine[];
  docs: Doc[];
  rules: MerchantRule[];
  /** Optional: where to look for a missing document (an email index, say). */
  hintsFor?: (line: BankLine) => string[];
  /** Document ids a previous month already matched to a payment. Never matched again. */
  alreadyPaid?: Set<string>;
  /** Payments tied to a document by hand. */
  evidence?: BankEvidence[];
}
