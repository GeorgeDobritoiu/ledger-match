import type {
  AccountSummary,
  BankLine,
  Doc,
  LineMatch,
  MerchantRule,
  MonthReconciliation,
  ReconciledLine,
  ReconcileInput,
} from "./types.ts";
import { daysBetween, monthBounds, round2, shiftDays, sum } from "./util.ts";

/**
 * Bank and card reconciliation for a calendar month. Every line is either matched to a
 * document, explained by its nature (a transfer between the company's own accounts, interest,
 * a platform payout), or listed as a payment with no document and what to do about it.
 * Documents issued in the month that no account paid are listed too.
 *
 * The design rule is exception-first: the engine never guesses in order to raise the match
 * rate. A match it is not sure of is worth less than a short, honest list of what a person
 * still has to look at.
 */

const WINDOW_BEFORE = 60; // an invoice may be dated up to 60 days before the payment (paid late)
const WINDOW_AFTER = 40; // or up to 40 days after it (platforms that invoice the month on the 5th of the next)
const SUM_BEFORE = 30; // several documents paid together, or one paid in parts: they sit close to the payment
const SUM_AFTER = 14;
const STATEMENT_BEFORE = 100; // a cycle payment settles a whole month of invoices, up to ~3 months back
const STATEMENT_AFTER = 5;
const STATEMENT_MIN = 100; // below this, a transfer is not a supplier statement payment
/**
 * A card payment settles one order at a time, never a supplier statement. Without this, two card
 * charges to the same merchant will happily "settle" nine of its invoices, credit notes included.
 */
const STATEMENTS_NEVER_ON: BankLine["account"] = "card";

/** The [from, to) dates of the billing cycle that a statement payment on `date` settles. */
export function paidCycle(date: string, cycle: { startDay: number; lag: number }): { from: string; to: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  let idx = y * 12 + (m - 1) - (d >= cycle.startDay ? 0 : 1) - cycle.lag;
  const at = (i: number): string =>
    `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-${String(cycle.startDay).padStart(2, "0")}`;
  return { from: at(idx), to: at(++idx) };
}

/**
 * The foreign amount a card line prints for a purchase in another currency. Statements truncate
 * the figure — "AMOUNT IN USD 101." for 101.63, "USD 24.0" for 24.00 — so the document total is
 * compared as a string prefix rather than as a number. Rounding it would match the wrong invoice.
 */
export function foreignAmount(description: string): { currency: string; prefix: string } | null {
  const m = description.match(/AMOUNT\s+IN\s+([A-Z]{3})\s+([\d,]*\d\.?\d*)/i);
  if (!m) return null;
  return { currency: m[1]!.toUpperCase(), prefix: m[2]!.replace(/,/g, "") };
}

export function foreignMatches(doc: { total: number; currency: string }, f: { currency: string; prefix: string }): boolean {
  return doc.currency === f.currency && Math.abs(doc.total).toFixed(2).startsWith(f.prefix);
}

/** First rule whose regex matches the description. Order in the file is the priority. */
export function matchMerchant(description: string, rules: MerchantRule[]): MerchantRule | null {
  for (const r of rules) if (new RegExp(r.match, "i").test(description)) return r;
  return null;
}

function toMatch(d: Doc, how: LineMatch["how"]): LineMatch {
  return { docId: d.id, supplier: d.supplier, kind: d.kind, number: d.number, date: d.date, total: d.total, file: d.file, how };
}

/** Subsets of up to `k` items whose totals add up to `target` (within a penny). Small inputs only. */
function subsetSum<T>(items: T[], value: (t: T) => number, target: number, k: number): T[] | null {
  const n = Math.min(items.length, 14);
  const pick: T[] = [];
  const go = (start: number, left: number, depth: number): boolean => {
    if (Math.abs(left) < 0.005 && pick.length >= 2) return true;
    if (depth === k) return false;
    for (let i = start; i < n; i++) {
      pick.push(items[i]!);
      if (go(i + 1, round2(left - value(items[i]!)), depth + 1)) return true;
      pick.pop();
    }
    return false;
  };
  return go(0, target, 0) ? [...pick] : null;
}

/**
 * Any subset of `items` adding up to `target`, to the penny: a supplier statement paid in one
 * transfer, where the run may be two dozen invoices. Reachability over pennies with a predecessor
 * per sum — each item used once, and the order given decides which of several valid subsets wins.
 */
function statementSubset<T>(items: T[], value: (t: T) => number, target: number): T[] | null {
  const pennies = Math.round(target * 100);
  if (pennies <= 0 || pennies > 5_000_000 || items.length < 2 || items.length > 120) return null;
  const vals = items.map((t) => Math.round(value(t) * 100));
  const from = new Int32Array(pennies + 1).fill(-1);
  const reach = new Uint8Array(pennies + 1);
  reach[0] = 1;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]!;
    if (v <= 0 || v > pennies) continue;
    for (let s = pennies; s >= v; s--) {
      if (reach[s - v] && !reach[s]) {
        reach[s] = 1;
        from[s] = i;
      }
    }
    if (reach[pennies]) break;
  }
  if (!reach[pennies]) return null;
  const pick: T[] = [];
  for (let s = pennies; s > 0; ) {
    const i = from[s]!;
    if (i < 0) return null;
    pick.push(items[i]!);
    s -= vals[i]!;
  }
  return pick.length >= 2 ? pick.reverse() : null;
}

/**
 * A run of consecutive documents (sorted by date) adding up to `target`. A statement covers a
 * billing cycle, so a contiguous run is tried before any subset: with dozens of small invoices,
 * an arbitrary subset hits the amount by chance often enough to be dangerous — a transfer paying
 * June's invoices will cheerfully "match" eleven of July's. Earliest run wins.
 */
function contiguousRun<T>(items: T[], value: (t: T) => number, target: number): T[] | null {
  const pennies = Math.round(target * 100);
  const vals = items.map((t) => Math.round(value(t) * 100));
  const credits = vals.some((v) => v < 0); // credit notes on the statement: running sums can fall back
  for (let i = 0; i < vals.length; i++) {
    let s = 0;
    for (let j = i; j < vals.length; j++) {
      s += vals[j]!;
      if (s === pennies && j > i) return items.slice(i, j + 1);
      if (s > pennies && !credits) break;
    }
  }
  return null;
}

/** Credit notes reduce a supplier statement, whichever sign their total was stored with. */
const signedTotal = (d: Doc): number => (d.kind === "credit_note" ? -Math.abs(d.total) : d.total);

const statementSet = <T>(items: T[], value: (t: T) => number, target: number): T[] | null =>
  contiguousRun(items, value, target) ?? statementSubset(items, value, target);

/**
 * Pure matching: no files, no database, no network. Everything the engine knows arrives in
 * `input`, which is what makes the passes below testable one at a time.
 */
export function reconcile(input: ReconcileInput): MonthReconciliation {
  const { month, rules } = input;
  const docs = [...input.docs];
  const used = new Set<string>(input.alreadyPaid ?? []);
  const out: ReconciledLine[] = [];
  const amountOf = (l: BankLine): number => round2(-l.amount); // payments positive, like documents
  const inWindow = (l: BankLine, d: Doc, before = WINDOW_BEFORE, after = WINDOW_AFTER): boolean => {
    const delta = daysBetween(l.authorisedDate ?? l.date, d.date);
    return delta >= -before && delta <= after;
  };
  // A supplier with a known billing cycle: only that cycle's documents. Otherwise a wide window.
  const inStatementWindow = (l: BankLine, d: Doc, rule: MerchantRule): boolean => {
    if (!rule.cycle) return inWindow(l, d, STATEMENT_BEFORE, STATEMENT_AFTER);
    const c = paidCycle(l.authorisedDate ?? l.date, rule.cycle);
    return d.date >= c.from && d.date < c.to;
  };
  const closeness = (l: BankLine, d: Doc): number => Math.abs(daysBetween(l.authorisedDate ?? l.date, d.date));
  const lines = [...input.lines].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const pending: { line: ReconciledLine; rule: MerchantRule | null }[] = [];

  for (const l of lines) {
    const rule = matchMerchant(l.description, rules);
    const base: ReconciledLine = {
      ...l,
      merchant: rule?.supplier ?? l.description,
      ruleKind: rule?.kind ?? "unknown",
      status: "missing",
      matches: [],
      action: null,
      note: rule?.note ?? null,
      hints: [],
    };
    if (rule && (rule.kind === "transfer" || rule.kind === "internal" || rule.kind === "platform")) {
      base.status = rule.kind;
      out.push(base);
      continue;
    }
    const ev = input.evidence?.find((e) => e.account === l.account && e.date === l.date && Math.abs(e.amount - amountOf(l)) < 0.005);
    if (ev) {
      base.status = "matched";
      base.matches = [
        {
          docId: `evidence:${ev.account}|${ev.date}|${ev.amount}`,
          supplier: ev.supplier,
          kind: "statement",
          number: ev.document,
          date: ev.date,
          total: ev.amount,
          file: ev.file ?? null,
          how: "evidence",
        },
      ];
      base.note = ev.note ?? base.note;
      out.push(base);
      continue;
    }
    pending.push({ line: base, rule });
  }

  // Pass 1: one document per line. Pairs are ranked across all lines at once rather than line by
  // line. With a merchant that sells the same thing repeatedly — a dozen orders at 12.99 — a greedy
  // line-by-line pass takes the next order's invoice and shifts every later pair by one.
  const sterlingDoc = (d: Doc): boolean => !d.currency || d.currency === "GBP";
  const pairs: { p: (typeof pending)[number]; d: Doc; dist: number; probable: boolean }[] = [];
  for (const p of pending) {
    const l = p.line;
    const target = amountOf(l);
    const keys = p.rule?.keys ?? [];
    const foreign = foreignAmount(l.description);
    // A foreign-currency document against a line that does not print the foreign amount (a card
    // statement PDF usually does not): for a supplier with a rule, accept a plausible rate within
    // a week. Deliberately narrow — this is the weakest evidence the engine will act on.
    const plausibleRate = (d: Doc): boolean =>
      !foreign && keys.length > 0 && d.total > 0 && target / d.total > 0.65 && target / d.total < 0.95 && closeness(l, d) <= 7;
    let candidates = docs.filter(
      (d) =>
        !used.has(d.id) &&
        (sterlingDoc(d) ? Math.abs(d.total - target) < 0.005 : (!!foreign && foreignMatches(d, foreign)) || plausibleRate(d)) &&
        inWindow(l, d) &&
        (keys.length ? keys.includes(d.supplierKey) : true),
    );
    // A merchant with no rule is matched on amount alone, so only within a week: 54.00 to one
    // supplier will otherwise take a 53.99 invoice from another, a month later.
    if (!keys.length) candidates = candidates.filter((d) => closeness(l, d) <= 7);
    // An invoice more than two weeks after a payment is not that payment's document: without this,
    // a 30 July payment takes the invoice of 17 August and leaves the 18 August payment bare.
    candidates = candidates.filter((d) => daysBetween(l.authorisedDate ?? l.date, d.date) <= 14);
    if (!candidates.length) continue;
    if (!keys.length && candidates.length > 1) continue; // unknown merchant, ambiguous amount: leave it alone
    // A document dated after the payment counts half again as far, because a bill normally precedes
    // its payment. By plain distance, an August payment will take September's bill.
    const ref = l.authorisedDate ?? l.date;
    for (const d of candidates) {
      pairs.push({ p, d, dist: closeness(l, d) * (d.date > ref ? 1.5 : 1) + (d.fallback ? 0.5 : 0), probable: !keys.length });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist || a.p.line.date.localeCompare(b.p.line.date) || a.d.date.localeCompare(b.d.date));
  for (const { p, d, probable } of pairs) {
    const l = p.line;
    if (l.status === "matched" || used.has(d.id)) continue;
    used.add(d.id);
    l.matches = [sterlingDoc(d) ? toMatch(d, probable ? "probable" : "exact") : { ...toMatch(d, "foreign"), currency: d.currency }];
    l.status = "matched";
  }

  // Pass 2: several of the supplier's documents paid in one line.
  for (const p of pending) {
    const l = p.line;
    if (l.status === "matched" || !p.rule?.keys?.length) continue;
    if (p.rule.cycle && amountOf(l) >= STATEMENT_MIN) continue; // a cycle payment: pass 2b decides it
    const target = amountOf(l);
    const pool = docs
      .filter((d) => !used.has(d.id) && p.rule!.keys!.includes(d.supplierKey) && inWindow(l, d, SUM_BEFORE, SUM_AFTER) && Math.abs(d.total) <= Math.abs(target) + 0.01)
      .sort((a, b) => closeness(l, a) - closeness(l, b));
    const set = subsetSum(pool, (d) => d.total, target, 3);
    if (!set) continue;
    for (const d of set) used.add(d.id);
    l.matches = set.map((d) => toMatch(d, "sum"));
    l.status = "matched";
  }

  const statementPass = (): void => {
    for (const p of pending) {
      const l = p.line;
      if (l.status === "matched" || !p.rule?.keys?.length || l.amount > 0 || amountOf(l) < STATEMENT_MIN || l.account === STATEMENTS_NEVER_ON) continue;
      const target = amountOf(l);
      const pool = docs
        .filter(
          (d) =>
            !used.has(d.id) &&
            p.rule!.keys!.includes(d.supplierKey) &&
            inStatementWindow(l, d, p.rule!) &&
            (d.kind === "credit_note" ? d.total !== 0 : d.total > 0 && d.total <= target + 0.01),
        )
        .sort((a, b) => a.date.localeCompare(b.date));
      const set = statementSet(pool, signedTotal, target);
      if (!set) continue;
      for (const d of set) used.add(d.id);
      l.matches = set.map((d) => toMatch(d, "statement"));
      l.status = "matched";
    }
  };

  // Pass 2c, before 2b: one statement paid in several transfers on the same day. Each transfer on
  // its own matches nothing, and the pair together matches the cycle exactly.
  const groups = new Map<string, typeof pending>();
  for (const p of pending) {
    const l = p.line;
    if (l.status === "matched" || !p.rule?.keys?.length || l.amount > 0 || l.account === STATEMENTS_NEVER_ON) continue;
    const k = `${l.account}|${l.date}|${p.rule.supplier}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const l = group[0]!.line;
    const rule = group[0]!.rule!;
    const target = round2(group.reduce((s, q) => s + amountOf(q.line), 0));
    if (target < STATEMENT_MIN) continue;
    const pool = docs
      .filter(
        (d) =>
          !used.has(d.id) &&
          rule.keys!.includes(d.supplierKey) &&
          inStatementWindow(l, d, rule) &&
          (d.kind === "credit_note" ? d.total !== 0 : d.total > 0 && d.total <= target + 0.01),
      )
      .sort((a, b) => a.date.localeCompare(b.date));
    const set = statementSet(pool, signedTotal, target);
    if (!set) continue;
    for (const d of set) used.add(d.id);
    for (const q of group) {
      q.line.matches = set.map((d) => toMatch(d, "statement"));
      q.line.status = "matched";
      q.line.note = `One of ${group.length} transfers on ${l.date} (together ${target.toFixed(2)}) paying this run of documents.`;
    }
  }
  statementPass();

  // Pass 3: one document paid across several lines of the same merchant, within a week.
  for (const p of pending) {
    const l = p.line;
    if (l.status === "matched" || !p.rule?.keys?.length) continue;
    const siblings = pending.filter((q) => q.line.status !== "matched" && q.rule === p.rule && Math.abs(daysBetween(l.date, q.line.date)) <= 7);
    const pool = docs.filter((d) => !used.has(d.id) && p.rule!.keys!.includes(d.supplierKey) && inWindow(l, d, SUM_BEFORE, SUM_AFTER));
    for (const d of pool) {
      const set = subsetSum(siblings, (q) => amountOf(q.line), d.total, 4);
      if (!set || !set.includes(p)) continue;
      used.add(d.id);
      for (const q of set) {
        q.line.matches = [toMatch(d, "split")];
        q.line.status = "matched";
      }
      break;
    }
  }

  // Whatever is left: money in is a refund (a credit note should follow), money out needs a document.
  for (const p of pending) {
    const l = p.line;
    if (l.status !== "matched") {
      if (l.amount > 0) {
        l.status = p.rule?.kind === "supplier" ? "refund" : "credit";
        l.note =
          l.note ??
          (l.status === "refund" ? "Refund from the supplier: a credit note should follow; none matched." : "Money in with no rule: check what it is.");
      } else {
        l.status = "missing";
        l.action = p.rule?.action ?? "No rule for this merchant: find the document, then add the merchant to the rules.";
        l.hints = input.hintsFor ? input.hintsFor(l) : [];
      }
    }
    out.push(l);
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const accounts: AccountSummary[] = [];
  for (const account of [...new Set(out.map((l) => l.account))]) {
    const ls = out.filter((l) => l.account === account);
    const missing = ls.filter((l) => l.status === "missing");
    const matched = ls.filter((l) => l.status === "matched");
    accounts.push({
      account,
      lines: ls.length,
      moneyOut: sum(ls.filter((l) => l.amount < 0).map((l) => -l.amount)),
      moneyIn: sum(ls.filter((l) => l.amount > 0).map((l) => l.amount)),
      matched: matched.length,
      matchedAmount: sum(matched.map((l) => -l.amount)),
      missing: missing.length,
      missingAmount: sum(missing.map((l) => -l.amount)),
      explained: ls.length - missing.length - matched.length,
      statements: [...new Map(ls.map((l) => [l.source, { source: l.source, path: l.path }])).values()],
    });
  }

  const { from, to } = monthBounds(month);
  const notes: string[] = [];
  // A statement that stops before the month ends leaves the last days unchecked, and a high match
  // rate over four fifths of a month is not a reconciled month. Say so rather than report a score.
  for (const a of accounts) {
    const last = out
      .filter((l) => l.account === a.account)
      .map((l) => l.date)
      .sort()
      .pop()!;
    const lastDay = shiftDays(to, -1);
    if (daysBetween(last, lastDay) > 3) {
      notes.push(`${a.account}: lines stop at ${last}; the statement covering ${shiftDays(last, 1)} to ${lastDay} is not loaded yet.`);
    }
  }

  const covered = (d: Doc): boolean => d.month === month && d.date >= from && d.date < to;
  // An invoice and a credit note of the same amount that moved no money cancel each other, and
  // neither belongs on a list of documents waiting to be paid.
  const cancelled = new Set<string>();
  for (const c of docs.filter((d) => d.kind === "credit_note" && !d.fallback && !used.has(d.id)).sort((a, b) => a.date.localeCompare(b.date))) {
    const inv = docs.find(
      (d) =>
        d.kind !== "credit_note" &&
        !d.fallback &&
        !used.has(d.id) &&
        !cancelled.has(d.id) &&
        d.supplierKey === c.supplierKey &&
        Math.abs(d.total + c.total) < 0.005 &&
        d.date <= c.date &&
        daysBetween(d.date, c.date) <= 30,
    );
    if (inv) cancelled.add(inv.id).add(c.id);
  }
  const unpaidDocs = docs
    .filter((d) => !d.fallback && covered(d) && !used.has(d.id) && !cancelled.has(d.id) && d.total > 0)
    .map((d) => ({ ...d, hint: "Not on any loaded account: paid from another account, personally, or in another month." }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { month, accounts, lines: out, missing: out.filter((l) => l.status === "missing"), unpaidDocs, notes };
}

/**
 * The payments that close with no document, as a CSV a person can work through.
 * UTF-8 with a BOM so Excel opens it without a wizard.
 */
export function missingDocumentsCsv(rec: Pick<MonthReconciliation, "missing">): string {
  const cell = (v: string | number | null): string => {
    let s = v === null ? "" : String(v);
    // Statement descriptions are untrusted text: a leading = + - @ runs as a formula in Excel.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["Date", "Authorised", "Account", "Description", "Merchant", "Amount", "What to do", "Where to look"];
  const rows = rec.missing.map((l) =>
    [l.date, l.authorisedDate ?? "", l.account, l.description, l.merchant, (-l.amount).toFixed(2), l.action ?? "", l.hints.join(" | ")]
      .map(cell)
      .join(","),
  );
  return "﻿" + [head.join(","), ...rows].join("\r\n") + "\r\n";
}
