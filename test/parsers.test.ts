import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseCardStatementText } from "../src/parsers/card-statement.ts";
import { parseBankCsv } from "../src/parsers/bank-csv.ts";

const here = dirname(fileURLToPath(import.meta.url));
const STATEMENT = readFileSync(resolve(here, "../fixtures/card-statement.txt"), "utf8");

test("card statement: rows, wrapped disputes, signs and a running balance that adds up", () => {
  const s = parseCardStatementText(STATEMENT, "card-statement-2026-07.pdf");
  assert.equal(s.from, "2026-07-05");
  assert.equal(s.to, "2026-08-04");
  assert.equal(s.opening, 1000);
  assert.equal(s.closing, 283.39);
  // 12 transactions: the opening and closing balance rows are not lines, and the per-card expense
  // statement after the closing balance repeats two purchases that must not be counted twice.
  assert.equal(s.lines.length, 12);
  assert.deepEqual(s.warnings, []);
  // Purchases raise the balance owed on the statement and come out negative here.
  assert.equal(s.lines[0]!.amount, -142.8);
  assert.equal(s.lines[0]!.authorisedDate, "2026-07-04");
  assert.equal(s.lines[0]!.date, "2026-07-06");
  assert.equal(s.lines[0]!.type, "Card");
  // The rewards redemption is money in.
  assert.equal(s.lines.find((l) => /Rewards/.test(l.description))!.amount, 95);
});

test("card statement: a dispute wrapped over six lines, with page furniture in the middle", () => {
  const s = parseCardStatementText(STATEMENT, "x.pdf");
  const dispute = s.lines.find((l) => l.type === "Card Transaction Dispute")!;
  assert.ok(dispute, "the wrapped row was not read at all");
  assert.equal(dispute.date, "2026-07-29");
  assert.equal(dispute.amount, 78.42); // a credit: money back in
  assert.match(dispute.description, /STACKHAUL\.IO/);
  assert.doesNotMatch(dispute.description, /Page 2/);
});

test("card statement: a running balance that does not add up is reported, not swallowed", () => {
  const s = parseCardStatementText(STATEMENT.replace("35.00 1316.22", "35.00 1317.22"), "x.pdf");
  assert.ok(s.warnings.some((w) => /Running balance breaks at 2026-07-12/.test(w)), s.warnings.join("; "));
  // Still returns the month: a wrong figure is worth more flagged than a month thrown away.
  assert.equal(s.lines.length, 12);
});

test("card statement: a closing balance the rows do not reach is reported", () => {
  const s = parseCardStatementText(STATEMENT.replace("£283.39", "£303.39"), "x.pdf");
  assert.ok(s.warnings.some((w) => /is not the closing balance/.test(w)), s.warnings.join("; "));
});

test("card statement: a zero interest charge is not a line", () => {
  const s = parseCardStatementText(STATEMENT.replace("12.40 283.39", "- 270.99").replace("£283.39", "£270.99"), "x.pdf");
  assert.equal(s.lines.length, 11);
  assert.deepEqual(s.warnings, []);
});

test("bank CSV: the signed-amount layout", () => {
  const p = parseBankCsv(
    `Number,Date,Account,Amount,Subcategory,Memo\n1,03/07/2026,00-00-00 00000000,-1234.56,DD,CARD REPAYMENT\n2,04/07/2026,00-00-00 00000000,150.00,FPI,MARKETPLACE PAYOUTS LTD\n`,
    "july.csv",
  );
  assert.equal(p.lines.length, 2);
  assert.deepEqual(
    p.lines.map((l) => [l.date, l.amount, l.type]),
    [
      ["2026-07-03", -1234.56, "DD"],
      ["2026-07-04", 150, "FPI"],
    ],
  );
  assert.equal(p.lines[0]!.id, "bank|2026-07-03|1");
});

test("bank CSV: the money-in / money-out layout, and two identical payments on one day", () => {
  const p = parseBankCsv(
    `Date,Description,Money in,Money out,Balance\n05/07/2026,NORTHWIND MARINE,,"1,000.00","2,500.10"\n05/07/2026,NORTHWIND MARINE,,"1,000.00","1,500.10"\n`,
    "s.csv",
  );
  assert.deepEqual(
    p.lines.map((l) => [l.amount, l.balance, l.id]),
    [
      [-1000, 2500.1, "bank|2026-07-05|-1000.00|NORTHWIND MARINE"],
      [-1000, 1500.1, "bank|2026-07-05|-1000.00|NORTHWIND MARINE#2"],
    ],
  );
});

test("bank CSV: a header it does not recognise is a warning, not a crash", () => {
  const p = parseBankCsv("Reference;Value\n1;2\n", "odd.csv");
  assert.equal(p.lines.length, 0);
  assert.match(p.warnings[0]!, /unrecognised header/);
});
