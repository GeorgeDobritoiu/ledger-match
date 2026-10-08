import type { BankLine } from "../types.ts";
import { round2 } from "../util.ts";

/**
 * A UK business current account, from the CSV a bank's online banking exports. High-street banks
 * do not offer a small business an API, so the month arrives as a download, and the same bank
 * ships two different layouts depending on which screen you export from:
 *
 *   Number,Date,Account,Amount,Subcategory,Memo     one signed amount column
 *   Date,Description,Money in,Money out,Balance     two unsigned columns
 *
 * Columns are found by name rather than position, because the order moves between exports.
 * Dates are dd/mm/yyyy. Amounts come out signed from the company's point of view.
 */

export interface BankCsvParse {
  account: "bank";
  lines: BankLine[];
  warnings: string[];
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function ukDate(s: string): string | null {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3]!.length === 2 ? "20" + m[3] : m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  const i = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return i ? `${i[1]}-${i[2]}-${i[3]}` : null;
}

function money(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.replace(/[£,\s]/g, "");
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? round2(n) : null;
}

export function parseBankCsv(text: string, source: string, path: string = source): BankCsvParse {
  const warnings: string[] = [];
  const lines: BankLine[] = [];
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!rows.length) return { account: "bank", lines, warnings: ["empty file"] };
  const head = splitCsv(rows[0]!).map((h) => h.toLowerCase());
  const col = (...names: string[]): number => head.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  const cDate = col("date", "transaction date");
  const cAmount = col("amount");
  const cIn = col("money in", "credit", "paid in");
  const cOut = col("money out", "debit", "paid out");
  const cMemo = col("memo", "description", "narrative", "details");
  const cSub = col("subcategory", "type", "transaction type");
  const cBal = col("balance");
  const cNum = col("number");
  if (cDate < 0 || (cAmount < 0 && cIn < 0 && cOut < 0)) {
    return { account: "bank", lines, warnings: [`unrecognised header: ${rows[0]}`] };
  }
  const seen = new Map<string, number>();
  for (const raw of rows.slice(1)) {
    const f = splitCsv(raw);
    const date = ukDate(f[cDate] ?? "");
    if (!date) continue;
    let amount: number | null = null;
    if (cAmount >= 0) amount = money(f[cAmount]);
    else {
      const inn = money(f[cIn]) ?? 0;
      const out = money(f[cOut]) ?? 0;
      amount = round2(inn - Math.abs(out));
    }
    if (amount === null) {
      warnings.push(`no amount on ${raw}`);
      continue;
    }
    const memo = (f[cMemo] ?? "").replace(/\s+/g, " ").trim();
    const type = cSub >= 0 ? (f[cSub] ?? "") : "";
    const balance = cBal >= 0 ? money(f[cBal]) : null;
    // Where the export numbers its rows, that number makes the id stable. Where it does not, two
    // identical payments to the same supplier on the same day would collapse into one line.
    const base = cNum >= 0 && f[cNum] ? `bank|${date}|${f[cNum]}` : `bank|${date}|${amount.toFixed(2)}|${memo}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    lines.push({
      id: n > 1 ? `${base}#${n}` : base,
      account: "bank",
      date,
      authorisedDate: null,
      type,
      description: memo,
      amount,
      balance,
      currency: "GBP",
      source,
      path,
    });
  }
  return { account: "bank", lines, warnings };
}
