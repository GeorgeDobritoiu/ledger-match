import type { BankLine } from "../types.ts";
import { round2 } from "../util.ts";

/**
 * A UK business credit-card statement, as the issuer emails it each month and as
 * `pdftotext -raw` renders it. The statement period runs from the 5th of one month to the 4th
 * of the next, which is why a "month" of card spending is never a calendar month.
 *
 * Most transactions survive on one line:
 *   <authorised dd/mm/yyyy | -> <cleared dd/mm/yyyy> <type> [*card] <description> <amount> <balance>
 *
 * Some do not. Dispute credits wrap across several lines, and page furniture lands in the middle
 * of a wrapped record, so a row is read from its pair of dates up to the first "<amount> <balance>"
 * pair and anything in between is joined. Purchases are positive on the statement — they raise the
 * balance owed — and are flipped here, so that money out is negative everywhere in this codebase.
 *
 * The running balance is checked line by line. A statement that does not add up is the one thing
 * a parser must never pass on quietly: a mis-read row changes the month's figures and nothing
 * downstream can tell. The parser reports it and keeps going, rather than throwing away the month.
 */

export interface CardStatementParse {
  account: "card";
  from: string;
  to: string;
  opening: number;
  closing: number;
  lines: BankLine[];
  /** Everything that did not add up. Empty is the only good value. */
  warnings: string[];
}

function iso(d: string): string {
  const m = d.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d;
}

const START = /^(-|\d{2}\/\d{2}\/\d{4}) (\d{2}\/\d{2}\/\d{4})(?: (.*))?$/;
const END = /^(.*?) ?(-|-?\d[\d,]*\.\d{2}) (-?\d[\d,]*\.\d{2})$/;
const TYPE = /^(Card Transaction Dispute|Card|Direct Debit|DD|Redemption|Interest|Fee|Payment|Refund|Credit|Adjustment|Transfer) (?:- )?(?:\*\d{4} )?(.*)$/;
/** Headers, page numbers and the issuer's address block, which appear inside wrapped records. */
const FURNITURE = /^(Authorised Date|Page \d|\d+$)|Copyright|Registered office/i;

const money = (s: string): number => (s === "-" ? 0 : round2(Number(s.replace(/,/g, ""))));

/** A summary figure such as "Opening Balance\n£10,309.84". The pound sign often arrives as U+FFFD. */
function summaryFigure(text: string, label: string): number | null {
  const i = text.indexOf(label);
  if (i < 0) return null;
  const m = text.slice(i + label.length, i + label.length + 40).match(/(-?)[^\d-]{0,3}(\d[\d,]*\.\d{2})/);
  return m ? round2(Number(`${m[1]}${m[2]}`.replace(/,/g, ""))) : null;
}

export function parseCardStatementText(text: string, source: string, path: string = source): CardStatementParse {
  const warnings: string[] = [];
  const period = text.match(/(\d{2} [A-Z][a-z]+ \d{4})\s*-\s*(\d{2} [A-Z][a-z]+ \d{4})/);
  const toIso = (s: string): string => {
    const d = new Date(`${s} UTC`);
    return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
  };
  const from = period ? toIso(period[1]!) : "";
  const to = period ? toIso(period[2]!) : "";
  const lines: BankLine[] = [];
  let opening: number | null = null;
  let prev: number | null = null;
  // The main table ends at the "Closing Balance" row. The per-card expense statement that follows
  // lists the same purchases again, without balances; counting those would double the month.
  let done = false;

  const emit = (auth: string, cleared: string, middle: string, amountS: string, balanceS: string): void => {
    const balance = money(balanceS);
    if (/Opening Balance/i.test(middle)) {
      opening = balance;
      prev = balance;
      return;
    }
    if (/Closing Balance/i.test(middle)) {
      done = true;
      return;
    }
    const amount = money(amountS);
    if (amount === 0) return; // "Interest Charge ... -" when nothing is owed
    const tm = middle.replace(/\s+/g, " ").trim().match(TYPE);
    const type = tm ? tm[1]! : "";
    const description = (tm ? tm[2]! : middle).replace(/\s+/g, " ").trim();
    if (prev !== null && Math.abs(round2(prev + amount) - balance) > 0.005) {
      warnings.push(`Running balance breaks at ${iso(cleared)} ${description}: ${prev} + ${amount} is not ${balance}`);
    }
    prev = balance;
    lines.push({
      id: `card|${iso(cleared)}|${balance.toFixed(2)}|${amount.toFixed(2)}`,
      account: "card",
      date: iso(cleared),
      authorisedDate: auth === "-" ? null : iso(auth),
      type,
      description,
      amount: round2(-amount),
      balance,
      currency: "GBP",
      source,
      path,
    });
  };

  let cur: { auth: string; cleared: string; parts: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (done) break;
    const line = raw.trim();
    const st = line.match(START);
    if (st) {
      if (cur) warnings.push(`Row without amount at ${iso(cur.cleared)}: ${cur.parts.join(" ")}`);
      cur = { auth: st[1]!, cleared: st[2]!, parts: st[3] ? [st[3]] : [] };
    } else if (cur) {
      if (FURNITURE.test(line)) continue;
      cur.parts.push(line);
    } else continue;
    const en = cur.parts.join(" ").match(END);
    if (en) {
      emit(cur.auth, cur.cleared, en[1]!, en[2]!, en[3]!);
      cur = null;
    }
  }
  if (cur) warnings.push(`Row without amount at ${iso(cur.cleared)}: ${cur.parts.join(" ")}`);

  const closing = summaryFigure(text, "Closing Balance") ?? prev ?? 0;
  if (opening === null) {
    opening = summaryFigure(text, "Opening Balance");
    if (opening === null) warnings.push("opening balance not found");
    else if (lines.length && Math.abs(round2(opening - lines[0]!.amount) - lines[0]!.balance!) > 0.005) {
      warnings.push(`first row does not follow the opening balance ${opening}`);
    }
  }
  if (prev !== null && Math.abs(prev - closing) > 0.005) {
    warnings.push(`last running balance ${prev} is not the closing balance ${closing}`);
  }
  return { account: "card", from, to, opening: opening ?? 0, closing, lines, warnings };
}
