/** Round to 2 decimal places, avoiding the usual floating point surprises. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function sum(values: number[]): number {
  return round2(values.reduce((a, b) => a + b, 0));
}

export function assertMonth(m: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error(`Month must look like 2026-07, got "${m}"`);
  return m;
}

/** First day of the month and first day of the next, as YYYY-MM-DD. */
export function monthBounds(month: string): { from: string; to: string } {
  assertMonth(month);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

export function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
}
