"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GST_SLABS, REGISTRY, inr } from "@/lib/checks";
import { BUYER } from "@/lib/data";
import { MIN_TEXT_CHARS } from "@/lib/limits";
import { DEFAULT_RULES, NUMBER_FIELDS, type CheckMode, type RuleSet, type RuleSettings } from "@/lib/rules";

const pct = (n: number) => `${+(n * 100).toFixed(2)}%`;
type NumKey = (typeof NUMBER_FIELDS)[number]["key"];

// Plain-English description of every check, written against the given settings.
// The list itself comes from REGISTRY (the code that runs), so a new check always shows up here.
function describe(r: RuleSettings): Record<string, { what: string; onFail: string; tone: "REJECT" | "HOLD" | "MIXED" }> {
  return {
    vendor_status: { what: "The vendor (found by GSTIN, else by name) is in the vendor master and is not blocked.", onFail: "Blocked vendor → Reject. Unknown vendor → Hold.", tone: "MIXED" },
    sender_domain: { what: "For emailed invoices: the sender's address is on the vendor's email domain, or is in the trusted senders list. Skipped for uploads.", onFail: "Hold: possible fraud.", tone: "HOLD" },
    duplicate_exact: { what: "This exact file, or the same vendor + invoice number, has not been processed before.", onFail: "Reject: duplicate.", tone: "REJECT" },
    duplicate_near: { what: `No earlier invoice from the same vendor has a total within ${inr(r.nearDupToleranceInr)} under a different invoice number.`, onFail: "Hold: possible re-sent copy.", tone: "HOLD" },
    document_type: { what: "The document is a tax invoice. Credit notes, debit notes and pro-forma invoices are recognised from their printed title (and the AI) and sent to their own workflow.", onFail: "Hold: separate workflow, not paid as an invoice.", tone: "HOLD" },
    extraction_confidence: { what: "Invoice number, date, vendor GSTIN and total read by the AI each appear word-for-word in the document, so they were not misread or invented.", onFail: "Hold: a person confirms the value.", tone: "HOLD" },
    invoice_date: { what: `The invoice date is a real calendar date, not in the future, and not older than ${r.maxInvoiceAgeDays} days.`, onFail: "Hold: invalid, future or out-of-period date.", tone: "HOLD" },
    tax_rate: { what: `Total GST divided by the taxable amount equals a GST slab (${GST_SLABS.join("%, ")}%), and CGST equals SGST.`, onFail: "Hold: tax amount or rate is wrong.", tone: "HOLD" },
    currency: { what: "The currency printed on the invoice is the same as the PO currency (INR). If it differs, the price check is skipped.", onFail: "Hold: convert or ask for a re-issued invoice.", tone: "HOLD" },
    required_fields: { what: "Invoice number, invoice date, vendor name and total are all on the invoice.", onFail: "Hold.", tone: "HOLD" },
    gstin_format: { what: "The vendor GSTIN has the right 15-character pattern and its check digit is valid.", onFail: "Hold: likely a typo or altered digit.", tone: "HOLD" },
    gstin_match: { what: "The GSTIN on the invoice equals the GSTIN in the vendor master.", onFail: "Hold.", tone: "HOLD" },
    tax_type: { what: `Same state as the buyer (state ${BUYER.state}) → CGST + SGST. Different state → IGST.`, onFail: "Hold: wrong GST type.", tone: "HOLD" },
    po_found: { what: "The PO number exists. If it is missing or wrong, the app suggests the one open PO of this vendor that contains every invoice item.", onFail: "Hold (with a suggested PO when one fits).", tone: "HOLD" },
    po_belongs: { what: "The PO was issued to this vendor.", onFail: "Reject: invoice quotes another vendor's PO.", tone: "REJECT" },
    po_open: { what: "The PO is still open.", onFail: "Hold.", tone: "HOLD" },
    line_price: { what: `Each unit price is at most the PO price + ${pct(r.linePricePct)} (never more than ${inr(r.linePriceCapInr)} per unit above). Lower prices are fine.`, onFail: "Hold: price above tolerance.", tone: "HOLD" },
    line_qty: { what: `Each quantity fits in what is left on the PO line after earlier invoices${r.qtyTolerancePct ? `, plus ${pct(r.qtyTolerancePct)} of the ordered quantity` : ""}. This tracks one PO split across invoices.`, onFail: "Hold: would exceed the PO.", tone: "HOLD" },
    arithmetic: { what: `Line amounts add up to the subtotal, and subtotal + tax equals the total, within ${inr(r.arithmeticToleranceInr)}.`, onFail: "Hold.", tone: "HOLD" },
  };
}

const TONE = { REJECT: "Reject", HOLD: "Hold", MIXED: "Reject / Hold" } as const;
const MODES: { m: CheckMode; label: string }[] = [
  { m: "default", label: "Default" }, { m: "hold", label: "Hold" }, { m: "reject", label: "Reject" }, { m: "off", label: "Off" },
];
const strip = (r: RuleSettings): RuleSettings => ({
  linePricePct: r.linePricePct, linePriceCapInr: r.linePriceCapInr, qtyTolerancePct: r.qtyTolerancePct,
  arithmeticToleranceInr: r.arithmeticToleranceInr, nearDupToleranceInr: r.nearDupToleranceInr,
  maxInvoiceAgeDays: r.maxInvoiceAgeDays ?? DEFAULT_RULES.maxInvoiceAgeDays,
  checks: Object.fromEntries(Object.entries(r.checks ?? {}).filter(([, m]) => m !== "default")),
});
const fmt = (key: NumKey, v: number) => {
  const u = NUMBER_FIELDS.find((f) => f.key === key)!.unit;
  return u === "%" ? pct(v) : u === "days" ? `${v} days` : inr(v);
};
const labelOf = (id: string) => REGISTRY.find((r) => r.id === id)?.label ?? id;

/** Human-readable list of what differs between two rule settings. */
function diff(a: RuleSettings, b: RuleSettings): string[] {
  const out: string[] = [];
  for (const f of NUMBER_FIELDS) if (a[f.key] !== b[f.key]) out.push(`${f.label}: ${fmt(f.key, a[f.key])} → ${Number.isNaN(b[f.key]) ? "?" : fmt(f.key, b[f.key])}`);
  const ids = new Set([...Object.keys(a.checks), ...Object.keys(b.checks)]);
  ids.forEach((id) => {
    const x = a.checks[id] ?? "default", y = b.checks[id] ?? "default";
    if (x !== y) out.push(`${labelOf(id)}: ${x} → ${y}`);
  });
  return out;
}

const EXAMPLE: Record<NumKey, (r: RuleSettings) => string> = {
  linePricePct: (r) => `A ₹22,000 item may be billed up to ${inr(22000 + Math.min(22000 * r.linePricePct, r.linePriceCapInr))}.`,
  linePriceCapInr: (r) => `A ₹5,00,000 item may go at most ${inr(Math.min(500000 * r.linePricePct, r.linePriceCapInr))} above.`,
  qtyTolerancePct: (r) => `On a PO for 10 units, up to ${+(10 * (1 + r.qtyTolerancePct)).toFixed(1)} can be billed in total.`,
  arithmeticToleranceInr: (r) => `Totals may be off by ${inr(r.arithmeticToleranceInr)} for rounding.`,
  nearDupToleranceInr: (r) => `Two invoices ₹${r.nearDupToleranceInr} apart from one vendor are flagged.`,
  maxInvoiceAgeDays: (r) => `Today, invoices dated before ${new Date(Date.now() - r.maxInvoiceAgeDays * 86_400_000).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} are held.`,
};

export default function RulesView() {
  const [current, setCurrent] = useState<RuleSet | null>(null);
  const [history, setHistory] = useState<RuleSet[]>([]);
  const [draft, setDraft] = useState<RuleSettings | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "REJECT" | "HOLD" | "off" | "changed">("all");
  const [poPrice, setPoPrice] = useState(22000);
  const [invPrice, setInvPrice] = useState(23100);
  const [openVer, setOpenVer] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/rules", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.detail ?? d.title);
      setCurrent(d.current);
      setHistory(d.history);
      setDraft(strip(d.current));
    } catch (err) {
      setMsg({ ok: false, text: `Could not load the rules: ${(err as Error).message}` });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (rules: RuleSettings, why: string) => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules, reason: why }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.title);
      setMsg({ ok: true, text: `Saved as rule set v${d.current.version}. New invoices use it from now on; earlier decisions keep the version they were made with.` });
      setReason("");
      await load();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const base = useMemo(() => (current ? strip(current) : null), [current]);
  const docs = useMemo(() => (draft ? describe(draft) : null), [draft]);
  const changes = useMemo(() => (base && draft ? diff(base, draft) : []), [base, draft]);
  if (!current || !draft || !base || !docs) return <div className="panel muted">{msg?.text ?? "Loading rules…"}</div>;

  const dirty = changes.length > 0;
  const invalid = NUMBER_FIELDS.some((f) => { const v = draft[f.key]; const s = f.unit === "%" ? v * 100 : v; return Number.isNaN(v) || s < f.min || s > f.max; });
  const isDefault = diff(strip({ ...DEFAULT_RULES, checks: {} }), base).length === 0;

  const setNum = (key: NumKey, unit: "%" | "₹" | "days", value: string) =>
    setDraft((d) => d && ({ ...d, [key]: value === "" ? NaN : unit === "%" ? Number(value) / 100 : Number(value) }));
  const setMode = (id: string, mode: CheckMode) =>
    setDraft((d) => {
      if (!d) return d;
      const checks = { ...d.checks };
      if (mode === "default") delete checks[id]; else checks[id] = mode;
      return { ...d, checks };
    });

  // What-if: price check with the draft settings.
  const allowedAbove = Math.min(poPrice * draft.linePricePct, draft.linePriceCapInr);
  const priceMode = draft.checks.line_price ?? "default";
  const priceOk = invPrice <= poPrice + allowedAbove;
  const whatIf = priceMode === "off" ? "OFF" : priceOk ? "PASS" : priceMode === "reject" ? "REJECTED" : "HOLD";
  const overPct = poPrice > 0 ? ((invPrice - poPrice) / poPrice) * 100 : 0;

  const checkRows = REGISTRY.map((r, i) => {
    const d = docs[r.id];
    const mode: CheckMode = draft.checks[r.id] ?? "default";
    const tone = mode === "hold" ? "HOLD" : mode === "reject" ? "REJECT" : d?.tone ?? "HOLD";
    const changed = (base.checks[r.id] ?? "default") !== mode;
    return { r, i, d, mode, tone, changed };
  }).filter(({ r, d, mode, tone, changed }) => {
    const q = query.trim().toLowerCase();
    if (q && !`${r.label} ${r.id} ${d?.what ?? ""}`.toLowerCase().includes(q)) return false;
    if (filter === "off") return mode === "off";
    if (filter === "changed") return changed;
    if (filter === "REJECT") return mode !== "off" && (tone === "REJECT" || tone === "MIXED");
    if (filter === "HOLD") return mode !== "off" && (tone === "HOLD" || tone === "MIXED");
    return true;
  });
  const offCount = Object.values(draft.checks).filter((m) => m === "off").length;

  return (
    <div className={dirty ? "has-savebar" : ""}>
      <div className="page-title">
        <div>
          <h1>Rules</h1>
          <p>The AI only <b>reads</b> the invoice and <b>writes the explanation</b>. These rules make every decision, the same way every time.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="chip">rule set <b>v{current.version}</b></span>
          <span className="chip">{REGISTRY.length - offCount} of {REGISTRY.length} checks on</span>
          {!isDefault && <button className="btn" disabled={saving} onClick={() => save({ ...DEFAULT_RULES, checks: {} }, "Restored the default rules")}>↺ Restore defaults</button>}
        </div>
      </div>

      {msg && <div className={`toast ${msg.ok ? "ok" : "bad"}`} role="status">{msg.ok ? "✓ " : "✕ "}{msg.text}</div>}

      <div className="section split rules-top">
        <section className="panel">
          <h2>How a decision is made</h2>
          <div className="ladder">
            <div><span className="badge REJECTED">✕ Rejected</span><span>if any check set to <b>Reject</b> fails</span></div>
            <div><span className="badge HOLD">! Hold for review</span><span>otherwise, if any check set to <b>Hold</b> fails</span></div>
            <div><span className="badge APPROVED">✓ Approved</span><span>only when no check fails</span></div>
          </div>
          <div className="small muted">
            v{current.version}{current.createdAt ? ` · saved ${new Date(current.createdAt).toLocaleString("en-IN")}` : ""} · “{current.reason}”. A reviewer can still override a Hold with a written reason.
          </div>
        </section>

        <section className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <h2>Try it: price check</h2>
            <span className="small muted">{dirty ? "uses your unsaved changes" : `uses rule set v${current.version}`}</span>
          </div>
          <div className="whatif">
            <label>PO price<span className="ruleinput"><span>₹</span><input type="number" min={0} value={poPrice} onChange={(e) => setPoPrice(Number(e.target.value) || 0)} /></span></label>
            <label>Invoice price<span className="ruleinput"><span>₹</span><input type="number" min={0} value={invPrice} onChange={(e) => setInvPrice(Number(e.target.value) || 0)} /></span></label>
          </div>
          <input className="range" type="range" min={Math.round(poPrice * 0.9)} max={Math.round(poPrice * 1.1)} step={Math.max(1, Math.round(poPrice / 1000))}
            value={invPrice} onChange={(e) => setInvPrice(Number(e.target.value))} aria-label="Invoice price" />
          <div className={`whatif-result ${whatIf}`}>
            <b>{whatIf === "PASS" ? "✓ Passes" : whatIf === "OFF" ? "– Check is off" : whatIf === "HOLD" ? "! Hold for review" : "✕ Rejected"}</b>
            <span>
              {overPct >= 0 ? `${overPct.toFixed(1)}% above` : `${Math.abs(overPct).toFixed(1)}% below`} the PO. Allowed: up to {inr(poPrice + allowedAbove)}
              {" "}(+{pct(draft.linePricePct)}, cap {inr(draft.linePriceCapInr)}).
            </span>
          </div>
        </section>
      </div>

      <section className="section">
        <h2>Tolerances</h2>
        <div className="tolgrid">
          {NUMBER_FIELDS.map((f) => {
            const v = draft[f.key];
            const shown = Number.isNaN(v) ? "" : f.unit === "%" ? +(v * 100).toFixed(2) : v;
            const changed = base[f.key] !== v;
            const sliderMax = f.unit === "%" ? 10 : f.unit === "days" ? 730 : f.key === "linePriceCapInr" ? 20000 : f.key === "arithmeticToleranceInr" ? 100 : 1000;
            const bad = Number.isNaN(v) || (shown as number) < f.min || (shown as number) > f.max;
            return (
              <div key={f.key} className={`panel tol ${changed ? "changed" : ""} ${bad ? "invalid" : ""}`}>
                <div className="tol-head">
                  <span className="small muted">{f.label}</span>
                  {changed && <span className="dotmark" title={`was ${fmt(f.key, base[f.key])}`}>changed</span>}
                </div>
                <div className="tol-val num">{Number.isNaN(v) ? "—" : fmt(f.key, v)}</div>
                <input className="range" type="range" min={f.min} max={Math.max(sliderMax, Number(shown) || 0)} step={f.unit === "%" ? 0.5 : sliderMax >= 1000 ? 50 : 1}
                  value={Number(shown) || 0} onChange={(e) => setNum(f.key, f.unit, e.target.value)} aria-label={f.label} />
                <div className="tol-foot">
                  <span className="ruleinput">
                    {f.unit === "₹" && <span>₹</span>}
                    <input type="number" min={f.min} max={f.max} step={f.unit === "%" ? 0.1 : 1} value={shown} onChange={(e) => setNum(f.key, f.unit, e.target.value)} aria-label={`${f.label} exact value`} />
                    {f.unit === "%" && <span>%</span>}
                    {f.unit === "days" && <span>days</span>}
                  </span>
                  <span className="chip mono">{f.usedBy}</span>
                </div>
                <div className="small muted">{bad ? `Must be between ${f.min} and ${f.max}${f.unit === "%" ? "%" : f.unit === "days" ? " days" : " rupees"}.` : EXAMPLE[f.key](draft)}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="section panel">
        <div className="checks-bar">
          <h2 style={{ margin: 0 }}>The checks <span className="muted small">in the order they run</span></h2>
          <input className="search" type="search" placeholder="Search checks…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search checks" />
        </div>
        <div className="filters">
          {([["all", "All"], ["REJECT", "Can reject"], ["HOLD", "Can hold"], ["off", `Off ${offCount}`], ["changed", "Changed"]] as const).map(([k, l]) => (
            <button key={k} className={`fchip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <div className="rulelist">
          {checkRows.length === 0 && <div className="muted small">No checks match.</div>}
          {checkRows.map(({ r, i, d, mode, tone, changed }) => (
            <div key={r.id} className={`rulerow ${mode === "off" ? "off" : ""} ${changed ? "changed" : ""}`}>
              <div className="rr-num num">{i + 1}</div>
              <div className="rr-main">
                <div className="rr-title">
                  <b>{r.label}</b> <span className="mono small muted">{r.id}</span>
                  {changed && <span className="dotmark">changed</span>}
                </div>
                <div className="small">{d?.what ?? "—"}</div>
                <div className="small" style={{ marginTop: 4 }}>
                  {mode === "off" ? <span className="muted">Not checked: this check is skipped.</span> : (
                    <><span className={`pill FAIL ${tone === "HOLD" ? "hold" : ""}`}>If it fails: {TONE[tone]}</span>{" "}<span className="muted">{mode === "default" ? d?.onFail : "(set by you)"}</span></>
                  )}
                </div>
              </div>
              <div className="seg" role="radiogroup" aria-label={`Setting for ${r.label}`}>
                {MODES.map(({ m, label }) => (
                  <button key={m} role="radio" aria-checked={mode === m} className={`${mode === m ? "on" : ""} ${m}`} onClick={() => setMode(r.id, m)}>{label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {history.length > 0 && (
        <section className="section panel">
          <h2>Rule history <span className="muted small">click a version to see what changed</span></h2>
          <div className="timeline">
            {history.map((h, i) => {
              const prev = history[i + 1];
              const ch = prev ? diff(strip(prev), strip(h)) : [];
              const open = openVer === h.version;
              return (
                <div key={h.version} className={`tl-item ${h.version === current.version ? "current" : ""}`}>
                  <button className="tl-head" onClick={() => setOpenVer(open ? null : h.version)} aria-expanded={open}>
                    <span className="tl-dot" aria-hidden />
                    <b className="mono">v{h.version}</b>
                    {h.version === current.version && <span className="chip chip-accent">current</span>}
                    <span className="small">{h.reason}</span>
                    <span className="small muted" style={{ marginLeft: "auto" }}>{h.createdAt ? new Date(h.createdAt).toLocaleString("en-IN") : ""}</span>
                  </button>
                  {open && (
                    <ul className="small tl-body">
                      {!prev ? <li>Starting rules.</li> : ch.length === 0 ? <li>No setting changed.</li> : ch.map((c) => <li key={c}>{c}</li>)}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="section panel">
        <h2>Before the checks run <span className="muted small">(fixed)</span></h2>
        <div className="prechecks">
          <div><b>1 · File check</b><span>PDF, JPG, PNG or WEBP, up to 4 MB. Password-protected or broken files are <b>Stopped safely</b>.</span></div>
          <div><b>2 · Reading</b><span>Normal PDFs use their text. Photos, scans and PDFs with under {MIN_TEXT_CHARS} characters of text go to <b>LlamaParse OCR</b>.</span></div>
          <div><b>3 · Classify</b><span>The AI decides if it is an invoice. Reminders and statements become <b>Not an invoice</b>.</span></div>
          <div><b>4 · Extract</b><span>The AI fills a strict form. Each value is checked against the document text.</span></div>
          <div><b>5 · Match</b><span>Vendor by GSTIN (else name), PO by number (else best-fitting open PO), lines by item code.</span></div>
        </div>
      </section>

      {dirty && (
        <div className="savebar" role="region" aria-label="Unsaved rule changes">
          <div className="sb-changes">
            <b>{changes.length} unsaved change{changes.length > 1 ? "s" : ""}</b>
            <span className="small muted" title={changes.join("\n")}>{changes.slice(0, 2).join(" · ")}{changes.length > 2 ? ` · +${changes.length - 2} more` : ""}</span>
          </div>
          <input className="search" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? e.g. Finance agreed 3% for Q4" aria-label="Reason for the change" />
          <button className="btn primary" disabled={saving || invalid || reason.trim().length < 5} onClick={() => save(draft, reason.trim())}
            title={invalid ? "Fix the invalid value first" : reason.trim().length < 5 ? "Write a reason (5+ characters)" : ""}>
            {saving ? "Saving…" : `Save as v${current.version + 1}`}
          </button>
          <button className="btn" disabled={saving} onClick={() => { setDraft(base); setReason(""); }}>Discard</button>
        </div>
      )}
    </div>
  );
}
