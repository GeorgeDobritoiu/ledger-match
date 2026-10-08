import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { foreignAmount, foreignMatches, matchMerchant, missingDocumentsCsv, paidCycle, reconcile } from "../src/reconcile.ts";
import { parseBankCsv } from "../src/parsers/bank-csv.ts";
import { parseCardStatementText } from "../src/parsers/card-statement.ts";
import type { BankEvidence, BankLine, Doc, MerchantRule, ReconciledLine } from "../src/types.ts";
import { monthBounds } from "../src/util.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string): string => readFileSync(resolve(here, "../fixtures", n), "utf8");
const { rules } = JSON.parse(fixture("merchants.json")) as { rules: MerchantRule[] };
const { documents, evidence } = JSON.parse(fixture("documents.json")) as { documents: Doc[]; evidence: BankEvidence[] };

function line(id: string, date: string, description: string, amount: number, account: "card" | "bank" = "card", authorisedDate: string | null = null): BankLine {
  return { id, account, date, authorisedDate, type: "Card", description, amount, balance: null, currency: "GBP", source: "s", path: "s" };
}

function doc(id: string, supplierKey: string, date: string, total: number, extra: Partial<Doc> = {}): Doc {
  return {
    id,
    supplierKey,
    supplier: supplierKey,
    kind: "invoice",
    number: id,
    date,
    total,
    currency: "GBP",
    file: null,
    month: date.slice(0, 7),
    ...extra,
  };
}

const run = (lines: BankLine[], docs: Doc[], extra: Partial<Parameters<typeof reconcile>[0]> = {}) =>
  reconcile({ month: "2026-07", lines, docs, rules, ...extra });

const byId = (r: ReturnType<typeof reconcile>, id: string): ReconciledLine => r.lines.find((l) => l.id === id)!;

test("paidCycle: which billing cycle a statement payment settles", () => {
  // Bills 6th to 5th, collects the cycle after: a payment on 20 July settles 6 June to 6 July.
  assert.deepEqual(paidCycle("2026-07-20", { startDay: 6, lag: 1 }), { from: "2026-06-06", to: "2026-07-06" });
  // A payment before the cycle start day belongs to the previous cycle.
  assert.deepEqual(paidCycle("2026-07-02", { startDay: 6, lag: 1 }), { from: "2026-05-06", to: "2026-06-06" });
  // Calendar month, collected two cycles later: a September Direct Debit pays July.
  assert.deepEqual(paidCycle("2026-09-02", { startDay: 1, lag: 2 }), { from: "2026-07-01", to: "2026-08-01" });
  // Across a year boundary.
  assert.deepEqual(paidCycle("2027-01-10", { startDay: 6, lag: 1 }), { from: "2026-12-06", to: "2027-01-06" });
});

test("a truncated foreign amount is read as a prefix, not rounded", () => {
  assert.deepEqual(foreignAmount("STACKHAUL.IO AMOUNT IN USD 101."), { currency: "USD", prefix: "101." });
  assert.deepEqual(foreignAmount("SOMETHING AMOUNT IN EUR 1,240.5"), { currency: "EUR", prefix: "1240.5" });
  assert.equal(foreignAmount("PENNINE FASTENERS LTD"), null);
  assert.ok(foreignMatches({ total: 101.63, currency: "USD" }, { currency: "USD", prefix: "101." }));
  assert.ok(!foreignMatches({ total: 101.63, currency: "EUR" }, { currency: "USD", prefix: "101." }));
  // 101.04 also begins "101." — the prefix is evidence, not proof, which is why a currency and a
  // date window are required alongside it.
  assert.ok(foreignMatches({ total: 101.04, currency: "USD" }, { currency: "USD", prefix: "101." }));
});

test("rules: first match wins", () => {
  assert.equal(matchMerchant("PENNINE FASTENERS LTD - 01422 000000", rules)!.supplier, "Pennine Fasteners");
  assert.equal(matchMerchant("Direct Debit", rules)!.kind, "transfer");
  assert.equal(matchMerchant("HARBOUR CAFE BAR - SALFORD", rules), null);
});

test("exact: one document for the amount", () => {
  const r = run([line("l1", "2026-07-06", "PENNINE FASTENERS LTD", -142.8, "card", "2026-07-04")], [doc("PF-1041", "pennine", "2026-07-03", 142.8)]);
  assert.equal(byId(r, "l1").status, "matched");
  assert.equal(byId(r, "l1").matches[0]!.how, "exact");
});

test("sum: several documents paid together", () => {
  const r = run(
    [line("l1", "2026-07-15", "TIDEWATER CHANDLERY", -219.9, "card", "2026-07-14")],
    [doc("TW-512", "tidewater", "2026-07-12", 129.95), doc("TW-519", "tidewater", "2026-07-13", 89.95)],
  );
  const l = byId(r, "l1");
  assert.equal(l.status, "matched");
  assert.deepEqual(l.matches.map((m) => m.how), ["sum", "sum"]);
  assert.deepEqual(l.matches.map((m) => m.docId).sort(), ["TW-512", "TW-519"]);
});

test("split: one document paid across two lines", () => {
  const r = run(
    [
      line("l1", "2026-07-11", "PENNINE FASTENERS LTD", -60, "card", "2026-07-10"),
      line("l2", "2026-07-12", "PENNINE FASTENERS LTD", -35, "card", "2026-07-11"),
    ],
    [doc("PF-1058", "pennine", "2026-07-09", 95)],
  );
  assert.equal(byId(r, "l1").matches[0]!.how, "split");
  assert.equal(byId(r, "l2").matches[0]!.docId, "PF-1058");
});

test("statement: a cycle payment settles a contiguous run, and only that cycle's documents", () => {
  const june = [
    doc("NM-801", "northwind", "2026-06-08", 214.5),
    doc("NM-802", "northwind", "2026-06-15", 332.1),
    doc("NM-803", "northwind", "2026-06-22", 118.4),
    doc("NM-804", "northwind", "2026-06-29", 96.0),
  ];
  // Two invoices from the next cycle that happen to add up to the same 761.00. Without the cycle
  // window the subset search would find them just as readily, and the month would look reconciled
  // while the wrong invoices were marked paid.
  const july = [doc("NM-830", "northwind", "2026-07-10", 400.0), doc("NM-831", "northwind", "2026-07-18", 361.0)];
  const r = run([line("b1", "2026-07-20", "NORTHWIND MARINE", -761, "bank")], [...june, ...july]);
  const l = byId(r, "b1");
  assert.equal(l.status, "matched");
  assert.deepEqual(l.matches.map((m) => m.docId), ["NM-801", "NM-802", "NM-803", "NM-804"]);
  assert.ok(l.matches.every((m) => m.how === "statement"));
  // The July pair is untouched and still waiting to be paid.
  assert.deepEqual(r.unpaidDocs.map((d) => d.id), ["NM-830", "NM-831"]);
});

test("statement: one cycle paid in two transfers on the same day", () => {
  const docs = [
    doc("CO-311", "castleford", "2026-06-11", 402.3),
    doc("CO-312", "castleford", "2026-06-18", 548.12),
    doc("CO-313", "castleford", "2026-06-25", 337.2),
  ];
  const r = run(
    [line("b1", "2026-07-24", "CASTLEFORD OILS", -394.8, "bank"), line("b2", "2026-07-24", "CASTLEFORD OILS", -892.82, "bank")],
    docs,
  );
  for (const id of ["b1", "b2"]) {
    const l = byId(r, id);
    assert.equal(l.status, "matched", `${id} was not matched`);
    assert.equal(l.matches.length, 3);
    assert.match(l.note!, /One of 2 transfers/);
  }
  // Three documents, consumed once between the two transfers rather than twice.
  assert.equal(r.unpaidDocs.length, 0);
});

test("statement: a card payment is never treated as a supplier statement", () => {
  const docs = [doc("NM-801", "northwind", "2026-06-08", 214.5), doc("NM-802", "northwind", "2026-06-15", 332.1)];
  const r = run([line("c1", "2026-07-20", "NORTHWIND MARINE", -546.6, "card", "2026-07-19")], docs);
  assert.equal(byId(r, "c1").status, "missing");
});

test("foreign: the amount printed on the line, and a plausible rate when it is not", () => {
  const r = run(
    [
      line("l1", "2026-07-09", "STACKHAUL.IO AMOUNT IN USD 101.", -78.42, "card", "2026-07-08"),
      line("l2", "2026-07-21", "STACKHAUL.IO", -15.54, "card", "2026-07-20"),
    ],
    [doc("SH-2291", "stackhaul", "2026-07-08", 101.63, { currency: "USD" }), doc("SH-2310", "stackhaul", "2026-07-19", 21.0, { currency: "USD" })],
  );
  assert.equal(byId(r, "l1").matches[0]!.docId, "SH-2291");
  assert.equal(byId(r, "l1").matches[0]!.currency, "USD");
  assert.equal(byId(r, "l2").matches[0]!.docId, "SH-2310");
});

test("a rate outside the plausible band is not a match", () => {
  // 15.54 against a 60.00 invoice is a quarter of the amount: not an exchange rate.
  const r = run([line("l1", "2026-07-21", "STACKHAUL.IO", -15.54, "card", "2026-07-20")], [doc("SH-9", "stackhaul", "2026-07-19", 60.0, { currency: "USD" })]);
  assert.equal(byId(r, "l1").status, "missing");
});

test("an unknown merchant: one candidate is probable, two are left alone", () => {
  const one = run([line("l1", "2026-07-18", "MOORGATE ELECTRICAL", -54, "card", "2026-07-17")], [doc("MG-77", "moorgate", "2026-07-16", 54)]);
  assert.equal(byId(one, "l1").matches[0]!.how, "probable");

  const two = run(
    [line("l1", "2026-07-18", "MOORGATE ELECTRICAL", -54, "card", "2026-07-17")],
    [doc("MG-77", "moorgate", "2026-07-16", 54), doc("XX-1", "elsewhere", "2026-07-17", 54)],
  );
  assert.equal(byId(two, "l1").status, "missing", "an ambiguous amount must not be guessed");
});

test("a document dated more than two weeks after the payment is not that payment's document", () => {
  const r = run([line("l1", "2026-07-10", "PENNINE FASTENERS LTD", -142.8, "card", "2026-07-09")], [doc("PF-x", "pennine", "2026-07-28", 142.8)]);
  assert.equal(byId(r, "l1").status, "missing");
});

test("evidence: a payment tied to a document by hand", () => {
  const r = run([line("b1", "2026-07-07", "NORTHWIND MARINE", -980, "bank")], [], { evidence });
  const l = byId(r, "b1");
  assert.equal(l.status, "matched");
  assert.equal(l.matches[0]!.how, "evidence");
  assert.match(l.note!, /tied to the statement by hand/);
});

test("documents already matched in an earlier month are never matched again", () => {
  const docs = [doc("PF-1041", "pennine", "2026-07-03", 142.8)];
  const lines = [line("l1", "2026-07-06", "PENNINE FASTENERS LTD", -142.8, "card", "2026-07-04")];
  assert.equal(byId(run(lines, docs), "l1").status, "matched");
  assert.equal(byId(run(lines, docs, { alreadyPaid: new Set(["PF-1041"]) }), "l1").status, "missing");
});

test("an invoice cancelled by a credit note is not waiting to be paid", () => {
  const r = run([], [doc("PF-1099", "pennine", "2026-07-28", 77.4), doc("PF-C19", "pennine", "2026-07-30", -77.4, { kind: "credit_note" })]);
  assert.deepEqual(r.unpaidDocs, []);
});

test("money in with a supplier rule is a refund, not a payment needing a document", () => {
  const r = run([line("b1", "2026-07-22", "TIDEWATER CHANDLERY REFUND", 129.95, "bank")], []);
  assert.equal(byId(r, "b1").status, "refund");
  assert.equal(r.missing.length, 0);
});

test("the exception list quotes a description that Excel would otherwise run as a formula", () => {
  const r = run([line("b1", "2026-07-29", "=cmd|' /c calc'!A1", -10, "bank")], []);
  const csv = missingDocumentsCsv(r);
  assert.ok(csv.startsWith("﻿"), "no BOM: Excel will mangle the encoding");
  assert.match(csv, /,'=cmd/, "a leading = must be defused with an apostrophe");
});

test("the whole invented month, end to end", () => {
  const { from, to } = monthBounds("2026-07");
  const card = parseCardStatementText(fixture("card-statement.txt"), "card.pdf");
  const bank = parseBankCsv(fixture("bank-july.csv"), "bank.csv");
  assert.deepEqual([...card.warnings, ...bank.warnings], [], "the fixtures should parse cleanly");

  const lines = [...card.lines, ...bank.lines].filter((l) => l.date >= from && l.date < to);
  const r = reconcile({ month: "2026-07", lines, docs: documents, rules, evidence });

  assert.equal(r.lines.length, 20);
  assert.equal(r.lines.filter((l) => l.status === "matched").length, 11);
  // Two payments, and only two, need a person: the café and the unknown logistics supplier.
  assert.deepEqual(
    r.missing.map((l) => l.description),
    ["HARBOUR CAFE BAR - SALFORD", "ASHDOWN LOGISTICS"],
  );
  // One invoice was issued in the month and paid by nothing loaded.
  assert.deepEqual(r.unpaidDocs.map((d) => d.id), ["NM-830"]);
  // Every matched line names at least one document.
  for (const l of r.lines.filter((x: ReconciledLine) => x.status === "matched")) assert.ok(l.matches.length > 0, `${l.id} matched nothing`);
  // No document is spent twice. One document may appear on several lines — a split payment, or a
  // statement settled by two transfers on the same day — but only ever as part of the same set of
  // matches. The same invoice justifying two unrelated payments is the failure worth guarding.
  const owners = new Map<string, Set<string>>();
  for (const l of r.lines) {
    const set = l.matches.map((m) => m.docId).sort().join("+");
    for (const m of l.matches) owners.set(m.docId, (owners.get(m.docId) ?? new Set()).add(set));
  }
  for (const [docId, sets] of owners) assert.equal(sets.size, 1, `${docId} justifies two unrelated payments`);
});
