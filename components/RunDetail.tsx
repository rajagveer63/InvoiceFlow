"use client";
import { useEffect, useState } from "react";
import { inr } from "@/lib/checks";
import { ICON, LABEL, effectiveDecision, view, type RunRecord } from "@/lib/runs";
import { STAGES, type CheckResult } from "@/lib/types";

function Badge({ d, big }: { d: string; big?: boolean }) {
  return <span className={`badge ${d} ${big ? "big" : ""}`}><span aria-hidden>{ICON[d]}</span>{LABEL[d] ?? d}</span>;
}
export { Badge };

type Tab = "checks" | "fields" | "po" | "timing";
type Filter = "ALL" | "FAIL" | "PASS" | "SKIPPED";
const order = (c: CheckResult) => (c.result === "FAIL" ? 0 : c.result === "SKIPPED" ? 2 : 1);

function CheckRow({ c, open, onToggle }: { c: CheckResult; open: boolean; onToggle: () => void }) {
  const hold = c.result === "FAIL" && c.onFail === "HOLD";
  const outcome = c.result === "FAIL" ? (c.onFail === "REJECT" ? "Fail → Reject" : "Fail → Hold") : c.result === "PASS" ? "Pass" : "Skipped";
  return (
    <div className={`xcheck ${c.result} ${hold ? "hold" : ""} ${open ? "open" : ""}`}>
      <button className="xcheck-head" onClick={onToggle} aria-expanded={open}>
        <span className={`cicon ${c.result} ${hold ? "hold" : ""}`} aria-hidden>{c.result === "PASS" ? "✓" : c.result === "FAIL" ? "!" : "–"}</span>
        <span className="label">{c.label}</span>
        <span className={`pill ${c.result}`}>{outcome}</span>
        <span className="chev" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="xcheck-body">
          <div className="small">{c.explanation}</div>
          {c.result !== "SKIPPED" && (
            <div className="cmp">
              <div><b>Expected</b><span className="mono">{c.expected}</span></div>
              <div><b>On invoice</b><span className="mono">{c.actual}</span></div>
            </div>
          )}
          <div className="small muted mono" style={{ marginTop: 6 }}>check id: {c.id}</div>
        </div>
      )}
    </div>
  );
}

export default function RunDetail({ run, pdfUrl, onBack, onOverride }: {
  run: RunRecord; pdfUrl?: string; onBack: () => void;
  onOverride: (decision: "APPROVED" | "REJECTED", reason: string) => void;
}) {
  const v = view(run);
  const eff = effectiveDecision(run);
  const system = v.decision?.decision;
  const [mode, setMode] = useState<null | "APPROVED" | "REJECTED">(null);
  const [reason, setReason] = useState("");
  const [tab, setTab] = useState<Tab>("checks");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [openChecks, setOpenChecks] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());
  const running = run.status === "running";

  // Live timer while the run streams in.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);

  // Esc goes back to the list (unless typing a reason).
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !mode) onBack(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onBack, mode]);

  const checks = v.checks ?? [];
  const counts = {
    FAIL: checks.filter((c) => c.result === "FAIL").length,
    PASS: checks.filter((c) => c.result === "PASS").length,
    SKIPPED: checks.filter((c) => c.result === "SKIPPED").length,
  };
  const shown = filter === "ALL" ? [...checks].sort((a, b) => order(a) - order(b)) : checks.filter((c) => c.result === filter);
  const isOpen = (c: CheckResult) => openChecks[c.id] ?? c.result === "FAIL";
  const allOpen = shown.length > 0 && shown.every(isOpen);
  const doneStages = STAGES.filter((s) => ["done", "skipped", "failed"].includes(v.stages[s.id].status)).length;
  const elapsed = v.totalMs ?? (running ? now - run.startedAt : undefined);
  const isImage = v.file?.mime?.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(run.fileName);
  const stageMs = STAGES.map((s) => ({ ...s, ms: v.stages[s.id].ms ?? 0, status: v.stages[s.id].status }));
  const maxMs = Math.max(1, ...stageMs.map((s) => s.ms));
  const burn = v.match?.burnDown ?? [];
  const activeTab: Tab = tab === "po" && burn.length === 0 ? "checks" : tab;

  return (
    <div className="run">
      <div className="panel run-head">
        <div style={{ minWidth: 0 }}>
          <button className="btn link small" onClick={onBack}>← All runs <span className="kbd">Esc</span></button>
          <div className="run-title">{v.extracted?.invoice_number ?? run.fileName}</div>
          <div className="chips">
            <span className="chip">{run.source === "email" ? <>✉ {run.sender}</> : "⇪ Uploaded"}</span>
            <span className="chip mono">{run.fileName}</span>
            {v.match?.vendorName && <span className="chip">{v.match.vendorName}</span>}
            {v.extracted?.total_amount != null && <span className="chip num">{inr(v.extracted.total_amount)}</span>}
            {v.file && <span className="chip">{isImage ? "image" : `${v.file.pages} page`} · {v.file.sizeKb} KB</span>}
            {v.file && <span className={`chip ${v.file.reader === "llamaparse" ? "chip-accent" : ""}`}>{v.file.reader === "llamaparse" ? "◎ read by LlamaParse OCR" : "≡ text layer"}</span>}
            {v.decision?.rulesVersion && <span className="chip">rule set v{v.decision.rulesVersion}</span>}
          </div>
        </div>
        <div className="run-side">
          <Badge d={eff} big />
          {elapsed != null && <div className="timer num">{(elapsed / 1000).toFixed(1)} s</div>}
        </div>
        {running && <div className="progress" aria-hidden><i style={{ width: `${Math.max(6, (doneStages / STAGES.length) * 100)}%` }} /></div>}
      </div>

      <div className="stepper" aria-live="polite">
        {STAGES.map((s, i) => {
          const st = v.stages[s.id];
          return (
            <div key={s.id} className={`step ${st.status}`}>
              <div className="circle" aria-hidden>
                {st.status === "done" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  : st.status === "failed" ? "✕" : i + 1}
              </div>
              <div className="name">{s.label}</div>
              <div className="meta">
                {st.status === "running" ? "working…" : st.status === "done" ? `${((st.ms ?? 0) / 1000).toFixed(1)} s` :
                  st.status === "failed" ? (st.note ?? "failed") : st.status === "skipped" ? "not needed" : "waiting"}
              </div>
            </div>
          );
        })}
      </div>

      <div className="runview">
        <div className="docpane">
          <div className="panel doc">
            <div className="doc-bar">
              <span className="small muted">{isImage ? "Invoice image" : "Invoice PDF"}</span>
              {pdfUrl && <a className="small" href={pdfUrl} target="_blank" rel="noreferrer">Open in new tab ↗</a>}
            </div>
            {pdfUrl ? (isImage
              ? <div className="pdf imgwrap"><img src={pdfUrl} alt="Invoice" /></div>
              : <iframe className="pdf" src={pdfUrl} title="Invoice PDF" />)
              : <div className="pdf-empty">The original file is not available.</div>}
          </div>
        </div>

        <div className="stack">
          <div className={`panel hero ${eff}`}>
            {!v.decision ? (
              <div>
                <div className="hero-k">Decision</div>
                <div className="muted small" style={{ margin: "6px 0 12px" }}>The rules decide once every check has run…</div>
                <div className="skeleton" /><div className="skeleton" style={{ width: "60%" }} />
              </div>
            ) : (
              <>
                <div className="hero-top">
                  <span className={`hero-icon ${eff}`} aria-hidden>{ICON[eff]}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="hero-k">{LABEL[eff] ?? eff}{run.override ? " · reviewer override" : ""}</div>
                    <div className="headline">{v.decision.headline}</div>
                  </div>
                </div>
                {run.override && (
                  <div className="note">
                    <b>{run.override.decision === "APPROVED" ? "Approved" : "Rejected"} by a reviewer</b>: “{run.override.reason}”. The system decision was <b>{LABEL[system!]}</b>.
                  </div>
                )}
                {v.decision.action && <div className="small" style={{ marginTop: 10 }}><b>What to do:</b> {v.decision.action}</div>}
                <div className="summary">
                  <div className="tag">{v.summary?.source === "auto" ? "Auto summary" : "✦ AI summary"}</div>
                  {v.summary ? <div>{v.summary.text}</div> : <><div className="skeleton" /><div className="skeleton" style={{ width: "70%" }} /></>}
                </div>
                {v.error && <div className="small" style={{ color: "var(--bad)", marginTop: 8 }}>Error detail: {v.error}</div>}
                {system === "HOLD" && !run.override && !mode && (
                  <div className="actions">
                    <button className="btn accent" onClick={() => setMode("APPROVED")}>✓ Approve anyway</button>
                    <button className="btn danger" onClick={() => setMode("REJECTED")}>✕ Reject</button>
                  </div>
                )}
                {mode && (
                  <div className="override">
                    <label className="small" htmlFor="reason">Reason for {mode === "APPROVED" ? "approving" : "rejecting"} (saved to the audit trail)</label>
                    <textarea id="reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Price increase agreed by procurement on 3 Nov" />
                    <div className="actions" style={{ marginTop: 0 }}>
                      <button className="btn primary" disabled={reason.trim().length < 5} onClick={() => { onOverride(mode, reason.trim()); setMode(null); setReason(""); }}>
                        Confirm {mode === "APPROVED" ? "approval" : "rejection"}
                      </button>
                      <button className="btn" onClick={() => setMode(null)}>Cancel</button>
                      <span className="small muted">{reason.trim().length < 5 ? `${5 - reason.trim().length} more characters` : "ready"}</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {v.classified && !v.classified.isInvoice && (
            <div className="panel">
              <h2>Why this is not an invoice</h2>
              <div>This looks like a <b>{v.classified.docType}</b>, not an invoice. No payment decision is needed.</div>
              <div className="small muted" style={{ marginTop: 6 }}>{v.classified.reason}</div>
            </div>
          )}

          {(checks.length > 0 || v.fields) && (
            <div className="panel">
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={activeTab === "checks"} className={activeTab === "checks" ? "on" : ""} onClick={() => setTab("checks")}>
                  Checks {counts.FAIL > 0 && <span className="tcount">{counts.FAIL}</span>}
                </button>
                <button role="tab" aria-selected={activeTab === "fields"} className={activeTab === "fields" ? "on" : ""} onClick={() => setTab("fields")}>What the AI read</button>
                {burn.length > 0 && <button role="tab" aria-selected={activeTab === "po"} className={activeTab === "po" ? "on" : ""} onClick={() => setTab("po")}>PO {v.match?.poNumber}</button>}
                <button role="tab" aria-selected={activeTab === "timing"} className={activeTab === "timing" ? "on" : ""} onClick={() => setTab("timing")}>Timing</button>
              </div>

              {activeTab === "checks" && (
                checks.length === 0 ? <div className="muted small">Checks run after matching…</div> : (
                  <div className="fadein" key="checks">
                    <div className="segbar" title={`${counts.PASS} passed · ${counts.FAIL} failed · ${counts.SKIPPED} skipped`}>
                      <i className="p" style={{ flex: counts.PASS }} /><i className="f" style={{ flex: counts.FAIL }} /><i className="s" style={{ flex: counts.SKIPPED }} />
                    </div>
                    <div className="filters">
                      {(["ALL", "FAIL", "PASS", "SKIPPED"] as Filter[]).map((f) => (
                        <button key={f} className={`fchip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
                          {f === "ALL" ? `All ${checks.length}` : f === "FAIL" ? `Failed ${counts.FAIL}` : f === "PASS" ? `Passed ${counts.PASS}` : `Skipped ${counts.SKIPPED}`}
                        </button>
                      ))}
                      <button className="btn link small" style={{ marginLeft: "auto" }}
                        onClick={() => setOpenChecks((o) => ({ ...o, ...Object.fromEntries(shown.map((c) => [c.id, !allOpen])) }))}>
                        {allOpen ? "Collapse all" : "Expand all"}
                      </button>
                    </div>
                    {shown.length === 0 ? <div className="muted small">Nothing here.</div> :
                      shown.map((c) => <CheckRow key={c.id} c={c} open={isOpen(c)} onToggle={() => setOpenChecks((o) => ({ ...o, [c.id]: !isOpen(c) }))} />)}
                  </div>
                )
              )}

              {activeTab === "fields" && (
                !v.fields ? <div className="muted small">Fields appear after extraction…</div> : (
                  <div className="fadein" key="fields">
                    <div className="small muted" style={{ marginBottom: 8 }}>
                      {v.fields.filter((f) => f.found).length} of {v.fields.length} values were found word-for-word in the document, so the AI did not make them up.
                    </div>
                    <div className="fields">
                      {v.fields.map((f) => (
                        <div className="field" key={f.key}>
                          <span className="k">{f.label}</span>
                          <span className={f.key.includes("gstin") || f.key.includes("number") ? "mono" : ""}>{f.value}</span>
                          {f.value === "Not on invoice" ? <span className="notfound">not on invoice</span>
                            : f.found ? <span className="found">✓ found in document</span> : <span className="notfound">location not found</span>}
                        </div>
                      ))}
                    </div>
                    {v.extracted && v.extracted.lines.length > 0 && (
                      <div className="tablewrap">
                        <table style={{ marginTop: 12 }}>
                          <thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
                          <tbody>
                            {v.extracted.lines.map((l, i) => (
                              <tr key={i}><td><span className="mono">{l.item_code}</span><div className="small muted">{l.description}</div></td>
                                <td className="num">{l.quantity}</td><td className="num">{inr(l.unit_price)}</td><td className="num">{inr(l.line_total)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              )}

              {activeTab === "po" && (
                <div className="fadein" key="po">
                  <div className="small muted" style={{ marginBottom: 10 }}>How much of each PO line is used, including this invoice.</div>
                  {burn.map((b) => {
                    const scale = Math.max(b.ordered, b.alreadyBilled + b.thisInvoice);
                    const pct = (n: number) => `${(n / scale) * 100}%`;
                    const after = b.alreadyBilled + b.thisInvoice;
                    const over = after > b.ordered;
                    return (
                      <div key={b.itemCode} style={{ marginBottom: 16 }}>
                        <div className="small"><b>{b.description}</b> <span className="mono muted">{b.itemCode}</span></div>
                        <div className="bar" role="img" aria-label={`${after} of ${b.ordered} ordered after this invoice`}>
                          <div className="used grow" style={{ width: pct(b.alreadyBilled) }} />
                          <div className={`pending grow ${over ? "over" : ""}`} style={{ left: pct(b.alreadyBilled), width: pct(b.thisInvoice) }} />
                          <div className="limit" style={{ left: `calc(${pct(b.ordered)} - 1px)` }} />
                        </div>
                        <div className="legend small">
                          <span><i className="lg used" />already billed {b.alreadyBilled}</span>
                          <span><i className={`lg pending ${over ? "over" : ""}`} />this invoice {b.thisInvoice}</span>
                          <span><i className="lg limit" />ordered {b.ordered}</span>
                          <b style={{ marginLeft: "auto", color: over ? "var(--bad)" : "var(--ink)" }}>{Math.round((after / b.ordered) * 100)}% of PO</b>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {activeTab === "timing" && (
                <div className="fadein" key="timing">
                  {stageMs.map((s) => (
                    <div className="trow" key={s.id}>
                      <span className="small">{s.label}</span>
                      <div className="tbar"><i className={`grow ${s.status}`} style={{ width: `${Math.max(2, (s.ms / maxMs) * 100)}%` }} /></div>
                      <span className="num small">{s.status === "skipped" || s.status === "pending" ? "—" : `${(s.ms / 1000).toFixed(2)} s`}</span>
                    </div>
                  ))}
                  <div className="small muted" style={{ marginTop: 8 }}>
                    Total {elapsed != null ? `${(elapsed / 1000).toFixed(1)} s` : "—"}. Classify and Extract call the AI; File check, Match, Validate and Decide are instant rule steps.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
