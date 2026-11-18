// Editable rule settings (stored as versions in the rule_versions table). Safe to import in the browser.

export type CheckMode = "default" | "hold" | "reject" | "off";

export interface RuleSettings {
  linePricePct: number;           // unit price may exceed the PO price by this fraction (0.02 = 2%)
  linePriceCapInr: number;        // ...but never by more than this many rupees per unit
  qtyTolerancePct: number;        // quantity may exceed what is left on the PO line by this fraction of the ordered qty
  arithmeticToleranceInr: number; // rounding allowed when adding up totals
  nearDupToleranceInr: number;    // totals this close (same vendor, different number) count as a possible re-sent copy
  maxInvoiceAgeDays: number;      // invoices dated earlier than this many days ago are outside the permitted period
  checks: Record<string, CheckMode>;
}

export interface RuleSet extends RuleSettings {
  version: number;
  reason?: string;
  createdAt?: number;
}

export const DEFAULT_RULES: RuleSettings = {
  linePricePct: 0.02,
  linePriceCapInr: 5000,
  qtyTolerancePct: 0,
  arithmeticToleranceInr: 1,
  nearDupToleranceInr: 1,
  maxInvoiceAgeDays: 180,
  checks: {},
};

export const DEFAULT_RULE_SET: RuleSet = { ...DEFAULT_RULES, version: 1, reason: "Default rules" };

export const MODE_LABEL: Record<CheckMode, string> = {
  default: "On (default outcome)",
  hold: "On, always Hold",
  reject: "On, always Reject",
  off: "Off",
};

/** Number fields with their editing limits (percent fields are edited as % in the UI). */
export const NUMBER_FIELDS: { key: Exclude<keyof RuleSettings, "checks">; label: string; unit: "%" | "₹" | "days"; min: number; max: number; usedBy: string }[] = [
  { key: "linePricePct", label: "Price tolerance above PO price", unit: "%", min: 0, max: 50, usedBy: "line_price" },
  { key: "linePriceCapInr", label: "Price tolerance cap (per unit)", unit: "₹", min: 0, max: 1_000_000, usedBy: "line_price" },
  { key: "qtyTolerancePct", label: "Quantity allowed above the PO", unit: "%", min: 0, max: 50, usedBy: "line_qty" },
  { key: "arithmeticToleranceInr", label: "Rounding allowed on totals", unit: "₹", min: 0, max: 10_000, usedBy: "arithmetic" },
  { key: "nearDupToleranceInr", label: "Near-duplicate: totals within", unit: "₹", min: 0, max: 100_000, usedBy: "duplicate_near" },
  { key: "maxInvoiceAgeDays", label: "Oldest invoice date accepted", unit: "days", min: 1, max: 3650, usedBy: "invoice_date" },
];

/** Returns cleaned settings, or an error message. Unknown check ids and modes are rejected. */
export function validateRules(input: unknown, checkIds: string[]): { ok: true; rules: RuleSettings } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Rules must be an object" };
  const src = input as Record<string, unknown>;
  const out: RuleSettings = { ...DEFAULT_RULES, checks: {} };
  for (const f of NUMBER_FIELDS) {
    const raw = Number(src[f.key]);
    const shown = f.unit === "%" ? raw * 100 : raw;
    if (!Number.isFinite(raw) || shown < f.min || shown > f.max)
      return { ok: false, error: `${f.label} must be between ${f.min} and ${f.max}${f.unit === "%" ? "%" : f.unit === "days" ? " days" : " rupees"}` };
    out[f.key] = f.unit === "%" ? Math.round(raw * 10000) / 10000 : f.unit === "days" ? Math.round(raw) : Math.round(raw * 100) / 100;
  }
  const checks = (src.checks ?? {}) as Record<string, unknown>;
  for (const [id, mode] of Object.entries(checks)) {
    if (!checkIds.includes(id)) return { ok: false, error: `Unknown check: ${id}` };
    if (!["default", "hold", "reject", "off"].includes(String(mode))) return { ok: false, error: `Unknown mode for ${id}` };
    if (mode !== "default") out.checks[id] = mode as CheckMode;
  }
  return { ok: true, rules: out };
}
