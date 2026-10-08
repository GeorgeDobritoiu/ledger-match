/**
 * Reconciles one invented month and prints what a person would act on.
 *
 *   npm run demo
 *
 * Everything it reads is in fixtures/: a card statement as `pdftotext -raw` renders it, a bank
 * CSV as online banking exports it, and a register of documents. No real company, supplier,
 * account or amount appears anywhere in this repository.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseCardStatementText } from "./src/parsers/card-statement.ts";
import { parseBankCsv } from "./src/parsers/bank-csv.ts";
import { missingDocumentsCsv, reconcile } from "./src/reconcile.ts";
import type { BankEvidence, Doc, MerchantRule } from "./src/types.ts";
import { monthBounds } from "./src/util.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(resolve(here, "fixtures", name), "utf8");

const MONTH = "2026-07";
const { from, to } = monthBounds(MONTH);

const card = parseCardStatementText(fixture("card-statement.txt"), "card-statement-2026-07.pdf");
const bank = parseBankCsv(fixture("bank-july.csv"), "bank-july.csv");
const { rules } = JSON.parse(fixture("merchants.json")) as { rules: MerchantRule[] };
const { documents, evidence } = JSON.parse(fixture("documents.json")) as { documents: Doc[]; evidence: BankEvidence[] };

// The card statement runs from the 5th to the 4th, so it carries days either side of the month.
const lines = [...card.lines, ...bank.lines].filter((l) => l.date >= from && l.date < to);

const rec = reconcile({ month: MONTH, lines, docs: documents, rules, evidence });

const money = (n: number): string => n.toFixed(2).padStart(9);
const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

console.log(`\nLedger-match — ${MONTH}\n`);

for (const w of [...card.warnings, ...bank.warnings]) console.log(`  statement warning: ${w}`);
if (card.warnings.length || bank.warnings.length) console.log();

console.log("  Account   Lines  Money out   Matched  Explained  No document");
for (const a of rec.accounts) {
  console.log(
    `  ${pad(a.account, 9)} ${String(a.lines).padStart(5)} ${money(a.moneyOut)} ${String(a.matched).padStart(9)} ${String(a.explained).padStart(10)} ${String(a.missing).padStart(12)}`,
  );
}

console.log("\n  Every line, and why it closed:\n");
for (const l of rec.lines) {
  const how = l.matches.length ? `${l.matches[0]!.how}: ${l.matches.map((m) => m.number ?? m.docId).join(", ")}` : l.status;
  console.log(`  ${l.date}  ${pad(l.account, 5)} ${money(-l.amount)}  ${pad(l.merchant, 26)} ${how}`);
}

console.log(`\n  ${rec.missing.length} payment(s) closed with no document — this is the list a person works through:\n`);
for (const l of rec.missing) {
  console.log(`  ${l.date}  ${money(-l.amount)}  ${l.description}`);
  console.log(`              ${l.action}`);
}

if (rec.unpaidDocs.length) {
  console.log(`\n  ${rec.unpaidDocs.length} document(s) issued this month that no loaded account paid:\n`);
  for (const d of rec.unpaidDocs) console.log(`  ${d.date}  ${money(d.total)}  ${d.supplier} ${d.number ?? ""} — ${d.hint}`);
}

for (const n of rec.notes) console.log(`\n  note: ${n}`);

console.log("\n  The exception list as CSV (first two lines):\n");
console.log(
  missingDocumentsCsv(rec)
    .split("\r\n")
    .slice(0, 2)
    .map((l) => `  ${l}`)
    .join("\n"),
);
console.log();
