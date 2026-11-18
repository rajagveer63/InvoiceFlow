const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function normalizeGstin(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** GSTIN check character (15th) computed from the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export function isValidGstin(raw: string | null | undefined): boolean {
  const g = normalizeGstin(raw);
  return PATTERN.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}
