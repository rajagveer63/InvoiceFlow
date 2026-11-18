// The check registry: one ordered list, read by Validate, the UI and the summary.
// The LLM never decides; these deterministic checks do.
import { BUYER, SEED_APPROVED, type PurchaseOrder, type POLine, type Vendor } from "./data";
import { fmtDate, parseInvoiceDate, todayIST } from "./dates";
import { isValidGstin, normalizeGstin } from "./gstin";
import { DEFAULT_RULE_SET, type RuleSet } from "./rules";
import type { BurnDown, CheckResult, Decision, Extracted, ExtractedLine, PriorRun } from "./types";

export const inr = (n: number | null | undefined) =>
  n == null ? "—" : "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

export interface LineMatch {
  line: ExtractedLine;
  poLine?: POLine;
  remainingBefore?: number;
}

export interface CheckContext {
  ex: Extracted;
  fileHash: string;
  vendor?: Vendor;
  vendorMatchedBy?: "gstin" | "name";
  po?: PurchaseOrder;
  poInferred?: string; // PO found by matching vendor + items because the invoice's PO number was missing or wrong
  lineMatches: LineMatch[];
  prior: PriorRun[];
  sender?: string; // email "from" address; undefined for uploads
  trustedSenders?: { email: string; vendorId?: string }[]; // trusted_senders table; vendorId empty = any vendor
  rules?: RuleSet; // editable settings from the rule_versions table (defaults when absent)
  docType?: string; // invoice | credit_note | debit_note | proforma (from Classify, backed by a keyword check)
  fieldsFound?: Record<string, boolean>; // was each extracted value found word-for-word in the document text?
  now?: number; // for tests; defaults to Date.now()
}

/** GST rates in force (incl. the 2025 GST 2.0 slabs 5/18/40 and the older 12/28, plus 0.25% and 3% for stones and gold). */
export const GST_SLABS = [0, 0.25, 3, 5, 12, 18, 28, 40];

const CURRENCY: Record<string, string> = { "₹": "INR", RS: "INR", "RS.": "INR", INR: "INR", RUPEE: "INR", RUPEES: "INR", "INDIAN RUPEE": "INR", "INDIAN RUPEES": "INR",
  $: "USD", US$: "USD", USD: "USD", DOLLAR: "USD", "US DOLLAR": "USD", "€": "EUR", EUR: "EUR", EURO: "EUR", "£": "GBP", GBP: "GBP" };
export const normCurrency = (c: string | null | undefined) => (c ? CURRENCY[c.trim().toUpperCase()] ?? c.trim().toUpperCase() : null);

const DOC_LABEL: Record<string, string> = { credit_note: "credit note", debit_note: "debit note", proforma: "pro-forma invoice" };

const R = (c: CheckContext) => c.rules ?? DEFAULT_RULE_SET;

/** Extra senders trusted for any vendor (demo: your own Gmail), from DEMO_TRUSTED_SENDERS (comma-separated). */
function trustedSenders(): string[] {
  return (process.env.DEMO_TRUSTED_SENDERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const sameInvoice = (ctx: CheckContext, p: PriorRun) =>
  !!ctx.vendor && p.vendorId === ctx.vendor.id && !!p.invoiceNumber &&
  p.invoiceNumber.toUpperCase() === (ctx.ex.invoice_number ?? "").toUpperCase();

/** Quantity already billed on a PO line by approved invoices (seed history + earlier approved runs). */
export function alreadyBilled(poNumber: string, itemCode: string, prior: PriorRun[], exclude?: (p: PriorRun) => boolean): number {
  const seed = SEED_APPROVED.filter((s) => s.poNumber === poNumber && s.itemCode === itemCode).reduce((a, s) => a + s.qty, 0);
  const runs = prior
    .filter((p) => p.effectiveDecision === "APPROVED" && p.poNumber === poNumber && !(exclude && exclude(p)))
    .flatMap((p) => p.lines ?? [])
    .filter((l) => l.itemCode === itemCode)
    .reduce((a, l) => a + l.qty, 0);
  return seed + runs;
}

export function burnDown(ctx: CheckContext): BurnDown[] {
  if (!ctx.po) return [];
  return ctx.lineMatches
    .filter((m) => m.poLine)
    .map((m) => ({
      poNumber: ctx.po!.number,
      itemCode: m.poLine!.itemCode,
      description: m.poLine!.description,
      ordered: m.poLine!.qty,
      alreadyBilled: m.poLine!.qty - (m.remainingBefore ?? m.poLine!.qty),
      thisInvoice: m.line.quantity ?? 0,
    }));
}

type Check = (ctx: CheckContext) => Omit<CheckResult, "id" | "label"> & { label?: string };

const pass = (expected: string, actual: string, explanation: string, onFail: "HOLD" | "REJECT" = "HOLD") =>
  ({ result: "PASS" as const, onFail, expected, actual, explanation });
const fail = (expected: string, actual: string, explanation: string, onFail: "HOLD" | "REJECT" = "HOLD") =>
  ({ result: "FAIL" as const, onFail, expected, actual, explanation });
const skip = (why: string, onFail: "HOLD" | "REJECT" = "HOLD") =>
  ({ result: "SKIPPED" as const, onFail, expected: "—", actual: "—", explanation: `Skipped because ${why}` });

export const REGISTRY: { id: string; label: string; run: Check }[] = [
  {
    id: "document_type", label: "It is a tax invoice (not a credit note or pro-forma)",
    run: (c) => {
      const t = c.docType ?? "invoice";
      if (t === "invoice") return pass("Tax invoice", "Tax invoice", "The document is a tax invoice");
      const what = DOC_LABEL[t] ?? t;
      const why = t === "credit_note" ? "a credit note reduces what we owe; it must be matched to the original invoice, not paid"
        : t === "proforma" ? "a pro-forma invoice is only a quote or advance request; payment waits for the final tax invoice"
        : "a debit note asks for an extra amount and needs its own approval";
      return fail("Tax invoice", what, `This is a ${what}: ${why}. Send it to the ${what} workflow`);
    },
  },
  {
    id: "vendor_status", label: "Vendor is known and approved",
    run: (c) => {
      if (!c.vendor) return fail("A vendor in the master list", c.ex.vendor_name ?? "no vendor name", "Vendor not found in the vendor master");
      if (c.vendor.status === "BLOCKED") return fail("Vendor status APPROVED", "BLOCKED", `${c.vendor.name} is blocked for payments`, "REJECT");
      if (c.vendor.status !== "APPROVED") return fail("Vendor status APPROVED", c.vendor.status, `${c.vendor.name} is not yet approved`);
      return pass("Vendor status APPROVED", "APPROVED", `${c.vendor.name} is an approved vendor`);
    },
  },
  {
    id: "sender_domain", label: "Email sender matches the vendor",
    run: (c) => {
      if (!c.sender) return skip("the invoice was uploaded, not emailed");
      if (!c.vendor) return skip("the vendor is unknown");
      if (c.vendor.status === "BLOCKED") return skip("the vendor is blocked");
      const from = c.sender.toLowerCase();
      const domain = from.split("@")[1] ?? "";
      const ok = domain === c.vendor.emailDomain || domain.endsWith("." + c.vendor.emailDomain) || trustedSenders().includes(from)
        || (c.trustedSenders ?? []).some((t) => t.email === from && (!t.vendorId || t.vendorId === c.vendor!.id));
      return ok
        ? pass(`@${c.vendor.emailDomain} or a registered sender`, from, `Sent from an address registered for ${c.vendor.name}`)
        : fail(`@${c.vendor.emailDomain} or a registered sender`, from, `Possible fraud: ${from} is not a registered sender for ${c.vendor.name}`);
    },
  },
  {
    id: "duplicate_exact", label: "Not already processed",
    run: (c) => {
      const dup = c.prior.find((p) => p.effectiveDecision !== "ERROR" && p.effectiveDecision !== "STOPPED" && p.effectiveDecision !== "IGNORED" && (p.fileHash === c.fileHash || sameInvoice(c, p)));
      if (dup) {
        const how = dup.fileHash === c.fileHash ? "the same PDF file" : `invoice ${c.ex.invoice_number} from this vendor`;
        return fail("A new invoice", `Already processed (${how})`, `Duplicate: ${how} was already processed`, "REJECT");
      }
      return pass("A new invoice", "No earlier match", "No earlier invoice with this number or file", "REJECT");
    },
  },
  {
    id: "duplicate_near", label: "Not a re-sent copy",
    run: (c) => {
      if (!c.vendor || c.ex.total_amount == null) return skip("vendor or total is unknown");
      const near = c.prior.find((p) => p.vendorId === c.vendor!.id && p.total != null && Math.abs(p.total - c.ex.total_amount!) <= R(c).nearDupToleranceInr
        && (p.effectiveDecision === "APPROVED" || p.effectiveDecision === "HOLD")
        && p.fileHash !== c.fileHash && !sameInvoice(c, p));
      return near
        ? fail("No other invoice from this vendor with the same total", `${near.invoiceNumber ?? "an earlier invoice"}, same total ${inr(near.total)}`,
            `Possible duplicate: ${near.invoiceNumber ?? "an earlier invoice"} from ${c.vendor.name} has the same total (${inr(near.total)}) under a different number`)
        : pass("No other invoice from this vendor with the same total", "No match", "No earlier invoice from this vendor has the same total");
    },
  },
  {
    id: "required_fields", label: "Required fields present",
    run: (c) => {
      const missing = ([["invoice_number", "invoice number"], ["invoice_date", "invoice date"], ["vendor_name", "vendor name"], ["total_amount", "total"]] as const)
        .filter(([k]) => c.ex[k] == null || c.ex[k] === "").map(([, l]) => l);
      return missing.length
        ? fail("Invoice number, date, vendor, total", `Missing: ${missing.join(", ")}`, `Missing on the invoice: ${missing.join(", ")}`)
        : pass("Invoice number, date, vendor, total", "All present", "All required fields are on the invoice");
    },
  },
  {
    id: "extraction_confidence", label: "Key values were read reliably",
    run: (c) => {
      if (!c.fieldsFound) return skip("the document text was not available");
      const crit = ([["invoice_number", "invoice number", c.ex.invoice_number], ["invoice_date", "invoice date", c.ex.invoice_date],
        ["vendor_gstin", "vendor GSTIN", c.ex.vendor_gstin], ["total_amount", "total", c.ex.total_amount != null ? inr(c.ex.total_amount) : null]] as const)
        .filter(([, , v]) => v != null);
      if (!crit.length) return skip("no key value was read");
      const unsure = crit.filter(([k]) => c.fieldsFound![k] === false);
      const expected = `${crit.map(([, l]) => l).join(", ")} found in the document`;
      return unsure.length
        ? fail(expected, `Not found: ${unsure.map(([, l, v]) => `${l} "${v}"`).join(", ")}`,
            `The AI read ${unsure.map(([, l, v]) => `${l} "${v}"`).join(" and ")}, but that text is not in the document, so it may be misread. A person should confirm it`)
        : pass(expected, `${crit.length} of ${crit.length} found`, "Every key value the AI read appears word-for-word in the document");
    },
  },
  {
    id: "invoice_date", label: "Invoice date is valid and in the permitted period",
    run: (c) => {
      if (!c.ex.invoice_date) return skip("there is no invoice date (see Required fields)");
      const d = parseInvoiceDate(c.ex.invoice_date);
      const days = R(c).maxInvoiceAgeDays ?? 180;
      const today = todayIST(c.now);
      const expected = `A real date between ${fmtDate(new Date(today.getTime() - days * 86_400_000))} and today (${fmtDate(today)})`;
      if (!d) return fail(expected, c.ex.invoice_date, `"${c.ex.invoice_date}" is not a valid calendar date`);
      const age = Math.round((today.getTime() - d.getTime()) / 86_400_000);
      if (age < 0) return fail(expected, fmtDate(d), `Invoice is dated ${fmtDate(d)}, ${-age} day${age === -1 ? "" : "s"} in the future`);
      if (age > days) return fail(expected, fmtDate(d), `Invoice is dated ${fmtDate(d)}, ${age} days ago: older than the ${days}-day permitted period`);
      return pass(expected, fmtDate(d), `Dated ${fmtDate(d)} (${age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`}), inside the permitted period`);
    },
  },
  {
    id: "gstin_format", label: "GSTIN is valid",
    run: (c) => {
      const g = normalizeGstin(c.ex.vendor_gstin);
      if (!g) return fail("A 15-character GSTIN", "none", "No vendor GSTIN on the invoice");
      return isValidGstin(g)
        ? pass("Valid GSTIN check character", g, "GSTIN format and check character are valid")
        : fail("Valid GSTIN check character", g, "GSTIN fails the check-character test (likely a typo or altered digit)");
    },
  },
  {
    id: "gstin_match", label: "GSTIN matches vendor record",
    run: (c) => {
      if (!c.vendor) return skip("the vendor is unknown");
      const g = normalizeGstin(c.ex.vendor_gstin);
      return g === c.vendor.gstin
        ? pass(c.vendor.gstin, g, "GSTIN matches the vendor master")
        : fail(c.vendor.gstin, g || "none", "GSTIN does not match the vendor record");
    },
  },
  {
    id: "tax_type", label: "Correct GST type for the states",
    run: (c) => {
      const { cgst, sgst, igst } = c.ex;
      if (cgst == null && sgst == null && igst == null) return skip("no tax breakdown is on the invoice");
      const vState = (c.vendor?.gstin ?? normalizeGstin(c.ex.vendor_gstin)).slice(0, 2);
      if (!vState) return skip("the vendor state is unknown");
      const intra = vState === BUYER.state;
      const ok = intra ? (cgst ?? 0) > 0 && (sgst ?? 0) > 0 && !(igst ?? 0) : (igst ?? 0) > 0 && !(cgst ?? 0) && !(sgst ?? 0);
      const expected = intra ? "CGST + SGST (same state)" : "IGST (different states)";
      const actual = [cgst ? "CGST" : "", sgst ? "SGST" : "", igst ? "IGST" : ""].filter(Boolean).join(" + ") || "none";
      return ok ? pass(expected, actual, `Tax type is right for vendor state ${vState} → buyer state ${BUYER.state}`)
        : fail(expected, actual, `Wrong tax type for vendor state ${vState} → buyer state ${BUYER.state}`);
    },
  },
  {
    id: "tax_rate", label: "GST rate and amount are correct",
    run: (c) => {
      const { cgst, sgst, igst } = c.ex;
      const tax = (cgst ?? 0) + (sgst ?? 0) + (igst ?? 0);
      if (cgst == null && sgst == null && igst == null) return skip("no tax breakdown is on the invoice");
      const lineSum = c.ex.lines.reduce((a, l) => a + (l.line_total ?? (l.quantity ?? 0) * (l.unit_price ?? 0)), 0);
      const base = c.ex.subtotal ?? lineSum;
      if (!base) return skip("the taxable amount is unknown");
      const rate = (tax / base) * 100;
      const slab = GST_SLABS.reduce((a, b) => (Math.abs(b - rate) < Math.abs(a - rate) ? b : a));
      const expected = `A GST slab (${GST_SLABS.filter((s) => s >= 5).join("%, ")}%) on ${inr(base)}`;
      const shown = `${+rate.toFixed(2)}% (${inr(tax)})`;
      const problems: string[] = [];
      if (cgst && sgst && Math.abs(cgst - sgst) > R(c).arithmeticToleranceInr) problems.push(`CGST ${inr(cgst)} and SGST ${inr(sgst)} should be equal halves`);
      if (Math.abs(rate - slab) > 0.05) problems.push(`tax is ${shown} of ${inr(base)}, which is not a GST rate (nearest slab ${slab}% would be ${inr(Math.round(base * slab) / 100)})`);
      return problems.length
        ? fail(expected, shown, `Tax looks wrong: ${problems.join("; ")}. If items carry different GST rates, check each line by hand`)
        : pass(expected, shown, `GST charged at ${slab}% of ${inr(base)}${cgst && sgst ? `, split equally into CGST and SGST` : ""}`);
    },
  },
  {
    id: "po_found", label: "Purchase order found",
    run: (c) => c.poInferred
      ? fail(`The PO number printed on the invoice`, c.ex.po_number ?? "no PO number",
          `${c.ex.po_number ? `PO ${c.ex.po_number} does not exist` : "No PO number on the invoice"}; best match is ${c.poInferred} (same vendor, every item is on it). Confirm before paying`)
      : c.po
      ? pass("A PO in the system", c.po.number, `Matched to ${c.po.number}`)
      : fail("A PO in the system", c.ex.po_number ?? "no PO number", c.ex.po_number ? `${c.ex.po_number} does not exist` : "No PO number on the invoice"),
  },
  {
    id: "po_belongs", label: "PO belongs to this vendor",
    run: (c) => {
      if (!c.po) return skip("no PO was found", "REJECT");
      if (!c.vendor) return skip("the vendor is unknown", "REJECT");
      return c.po.vendorId === c.vendor.id
        ? pass(c.vendor.name, c.vendor.name, `${c.po.number} was issued to ${c.vendor.name}`, "REJECT")
        : fail(c.vendor.name, `PO issued to vendor ${c.po.vendorId}`, `${c.po.number} belongs to a different vendor`, "REJECT");
    },
  },
  {
    id: "po_open", label: "PO is open",
    run: (c) => !c.po ? skip("no PO was found")
      : c.po.status === "OPEN" ? pass("OPEN", "OPEN", `${c.po.number} is open`) : fail("OPEN", c.po.status, `${c.po.number} is ${c.po.status.toLowerCase()}`),
  },
  {
    id: "currency", label: "Currency matches the PO",
    run: (c) => {
      const expected = c.po?.currency ?? "INR";
      const got = normCurrency(c.ex.currency);
      if (!got) return pass(expected, "not printed (₹ assumed)", `No other currency is printed, so amounts are taken as ${expected}`);
      return got === expected
        ? pass(expected, got, `Invoice is in ${got}, same as ${c.po ? c.po.number : "the buyer's books"}`)
        : fail(expected, got, `Invoice is in ${got} but ${c.po ? c.po.number : "the buyer's books"} ${c.po ? "is" : "are"} in ${expected}; prices cannot be compared until it is converted or re-issued`);
    },
  },
  {
    id: "line_price", label: "Unit prices match the PO",
    run: (c) => {
      if (!c.po) return skip("no PO was found");
      const cur = normCurrency(c.ex.currency);
      if (cur && cur !== c.po.currency) return skip(`the invoice is in ${cur} and the PO in ${c.po.currency}, so prices cannot be compared (see Currency)`);
      const bad: string[] = []; const exp: string[] = []; const act: string[] = [];
      for (const m of c.lineMatches) {
        const name = m.line.item_code ?? m.line.description ?? "line";
        if (!m.poLine) { bad.push(`${name} is not on ${c.po.number}`); continue; }
        const po = m.poLine.unitPrice; const got = m.line.unit_price ?? 0;
        const allowed = Math.min(po * R(c).linePricePct, R(c).linePriceCapInr);
        exp.push(`${name} ≤ ${inr(po + allowed)}`); act.push(`${name} ${inr(got)}`);
        if (got - po > allowed) bad.push(`${name} costs ${inr(got)}, PO price ${inr(po)} (+${(((got - po) / po) * 100).toFixed(1)}%, allowed ${+(R(c).linePricePct * 100).toFixed(2)}%)`);
      }
      return bad.length ? fail(exp.join("; ") || "Lines on the PO", act.join("; ") || "—", bad.join("; "))
        : pass(exp.join("; "), act.join("; "), "Every unit price is within tolerance of the PO price");
    },
  },
  {
    id: "line_qty", label: "Quantities within what is left on the PO",
    run: (c) => {
      if (!c.po) return skip("no PO was found");
      const bad: string[] = []; const exp: string[] = []; const act: string[] = [];
      for (const m of c.lineMatches) {
        if (!m.poLine) continue;
        const left = m.remainingBefore ?? m.poLine.qty; const q = m.line.quantity ?? 0;
        const extra = Math.floor(m.poLine.qty * R(c).qtyTolerancePct);
        exp.push(`${m.poLine.itemCode} ≤ ${left} left${extra ? ` (+${extra} tolerance)` : ""}`); act.push(`${m.poLine.itemCode} ${q}`);
        if (q > left + extra) bad.push(`${m.poLine.itemCode}: invoice bills ${q}, only ${left} of ${m.poLine.qty} left on ${c.po.number}`);
      }
      if (!exp.length) return skip("no invoice line matched a PO line");
      return bad.length ? fail(exp.join("; "), act.join("; "), bad.join("; ")) : pass(exp.join("; "), act.join("; "), "Quantities fit within the PO");
    },
  },
  {
    id: "arithmetic", label: "Totals add up",
    run: (c) => {
      const tol = R(c).arithmeticToleranceInr;
      const lineSum = c.ex.lines.reduce((a, l) => a + (l.line_total ?? (l.quantity ?? 0) * (l.unit_price ?? 0)), 0);
      const tax = (c.ex.cgst ?? 0) + (c.ex.sgst ?? 0) + (c.ex.igst ?? 0);
      const sub = c.ex.subtotal ?? lineSum;
      const total = c.ex.total_amount;
      if (total == null) return skip("the total is missing");
      const problems: string[] = [];
      if (Math.abs(lineSum - sub) > tol) problems.push(`lines add to ${inr(lineSum)} but subtotal is ${inr(sub)}`);
      if (Math.abs(sub + tax - total) > tol) problems.push(`subtotal ${inr(sub)} + tax ${inr(tax)} = ${inr(sub + tax)} but total is ${inr(total)}`);
      return problems.length ? fail(`${inr(sub + tax)}`, inr(total), problems.join("; "))
        : pass(`${inr(sub)} + ${inr(tax)} tax`, inr(total), "Lines, subtotal, tax and total agree");
    },
  },
];

export function runChecks(ctx: CheckContext): CheckResult[] {
  const modes = R(ctx).checks ?? {};
  return REGISTRY.map((c) => {
    const mode = modes[c.id] ?? "default";
    if (mode === "off") return { id: c.id, label: c.label, ...skip(`this check is turned off in rule set v${R(ctx).version}`) };
    const r = { id: c.id, label: c.label, ...c.run(ctx) };
    return mode === "hold" ? { ...r, onFail: "HOLD" as const } : mode === "reject" ? { ...r, onFail: "REJECT" as const } : r;
  });
}

export function decide(checks: CheckResult[]): { decision: Decision; headline: string } {
  const failed = checks.filter((c) => c.result === "FAIL");
  const reject = failed.find((c) => c.onFail === "REJECT");
  if (reject) return { decision: "REJECTED", headline: `Rejected: ${reject.explanation}` };
  if (failed.length) return { decision: "HOLD", headline: `Held: ${failed[0].explanation}` };
  return { decision: "APPROVED", headline: `Approved: all ${checks.filter((c) => c.result === "PASS").length} checks passed` };
}
