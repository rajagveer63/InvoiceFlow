// Reads invoice dates as printed on Indian invoices. Day comes before month (05/11/2026 = 5 November 2026).
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

function build(y: number, m: number, d: number): Date | null {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects impossible days such as 31/02 or 31/04.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}

/** Returns the date (UTC midnight) or null when the text is not a real calendar date. */
export function parseInvoiceDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return build(+m[1], +m[2], +m[3]); // 2026-11-05
  if ((m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/))) return build(year(m[3]), +m[2], +m[1]); // 05/11/2026
  if ((m = s.match(/^(\d{1,2})[-/. ]([a-z]{3,9})\.?[-/. ](\d{2}|\d{4})$/))) { // 05 Nov 2026, 05-Nov-26
    const mon = MONTHS.indexOf(m[2].slice(0, 3));
    return mon < 0 ? null : build(year(m[3]), mon + 1, +m[1]);
  }
  if ((m = s.match(/^([a-z]{3,9})\.? (\d{1,2}) (\d{4})$/))) { // Nov 5 2026
    const mon = MONTHS.indexOf(m[1].slice(0, 3));
    return mon < 0 ? null : build(+m[3], mon + 1, +m[2]);
  }
  return null;
}

export const fmtDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/** Today at UTC midnight, using India time (so a 5 Dec invoice is not "future" at 1 am IST on 5 Dec). */
export function todayIST(now = Date.now()): Date {
  const ist = new Date(now + 5.5 * 3600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}
