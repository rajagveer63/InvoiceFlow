"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DatabaseView from "@/components/DatabaseView";
import RulesView from "@/components/RulesView";
import TrustedSenders from "@/components/TrustedSenders";
import RunDetail, { Badge } from "@/components/RunDetail";
import { inr } from "@/lib/checks";
import { SAMPLES } from "@/lib/data";
import { effectiveDecision, view, type RunRecord } from "@/lib/runs";
import type { StreamEvent } from "@/lib/types";

const MAX_MB = 4;
const INBOX_EVERY_MS = 30_000;

interface Inbound { messageId: string; sender: string; subject: string; receivedAt: number; status: string; note: string }
interface Health { ok: boolean; database: string; ocr?: boolean; email: { configured: boolean; address?: string } }

export default function Home() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [live, setLive] = useState<RunRecord | null>(null); // the run streaming right now
  const [inbox, setInbox] = useState<Inbound[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState<"home" | "db" | "rules">("home");

  // Keep the current page in the URL hash (#rules, #db, #run/<id>) so a view can be linked or reloaded.
  const hashRead = useRef(false);
  useEffect(() => {
    const read = () => {
      const h = window.location.hash;
      if (h === "#rules" || h === "#db") { setOpenId(null); setPage(h.slice(1) as "rules" | "db"); }
      else if (h.startsWith("#run/")) { setPage("home"); setOpenId(decodeURIComponent(h.slice(5))); }
      else { setPage("home"); setOpenId(null); }
    };
    read();
    hashRead.current = true;
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  useEffect(() => {
    if (!hashRead.current) return;
    const h = page !== "home" ? `#${page}` : openId && !openId.startsWith("live-") ? `#run/${encodeURIComponent(openId)}` : "";
    if (h !== window.location.hash) window.history.pushState(null, "", h || window.location.pathname);
  }, [page, openId]);
  const showDb = page === "db";
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const localPdf = useRef<Record<string, string>>({});
  const checkingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.title);
      setRuns(data.runs);
      setInbox(data.inbox);
      setLoadError(null);
    } catch (err) {
      setLoadError(`Could not load run history: ${(err as Error).message}`);
    }
  }, []);

  const checkInbox = useCallback(async (manual = false) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const res = await fetch("/api/inbox/check", { method: "POST" });
      const data = await res.json();
      setLastCheck(Date.now());
      if (data.error) setNotice(data.error);
      else if (data.processed > 0) {
        const first = data.results?.[0];
        setNotice(`New email from ${first?.sender ?? "a vendor"}: ${data.processed} message${data.processed > 1 ? "s" : ""} processed${data.remaining ? `, ${data.remaining} more waiting` : ""}.`);
      } else if (manual) setNotice("No new emails.");
      if (data.processed > 0) await refresh();
    } catch {
      if (manual) setNotice("Inbox check failed. Try again.");
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (!health?.email.configured) return;
    checkInbox();
    const t = setInterval(() => { if (document.visibilityState === "visible") checkInbox(); }, INBOX_EVERY_MS);
    return () => clearInterval(t);
  }, [health?.email.configured, checkInbox]);

  const start = useCallback(async (file: File, sampleFile?: string) => {
    const tempId = `live-${Date.now()}`;
    let rec: RunRecord = { id: tempId, fileName: file.name, sampleFile, source: "upload", startedAt: Date.now(), status: "running", events: [] };
    const url = sampleFile ? `/samples/${sampleFile}` : URL.createObjectURL(file);
    localPdf.current[tempId] = url;
    setLive(rec);
    setOpenId(tempId);
    const push = (e: StreamEvent) => {
      if (e.type === "run") {
        localPdf.current[e.id] = url;
        rec = { ...rec, id: e.id };
        setOpenId(e.id);
      }
      rec = { ...rec, events: [...rec.events, e] };
      setLive(rec);
    };
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (sampleFile) fd.append("sampleFile", sampleFile);
      const res = await fetch("/api/process", { method: "POST", body: fd });
      if (!res.ok || !res.body) throw new Error(`Server answered ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) push(JSON.parse(line));
        }
      }
    } catch (err) {
      push({ type: "decision", decision: "ERROR", headline: "System error: could not reach the server", action: "Check your connection and try again." });
      push({ type: "error", message: (err as Error).message });
    }
    rec = { ...rec, status: "done" };
    setLive(rec);
    await refresh();
    setLive(null);
  }, [refresh]);

  const runSample = async (file: string) => {
    const res = await fetch(`/samples/${file}`);
    const blob = await res.blob();
    start(new File([blob], file, { type: blob.type || "application/pdf" }), file);
  };

  const onFiles = (files: FileList | null) => {
    setNotice(null);
    const f = files?.[0];
    if (!f) return;
    if (!/\.(pdf|jpe?g|png|webp)$/i.test(f.name) && !/^(application\/pdf|image\/(jpeg|png|webp))$/.test(f.type)) return setNotice("Only PDF, JPG, PNG or WEBP invoices are processed.");
    if (f.size > MAX_MB * 1024 * 1024) return setNotice(`This file is over ${MAX_MB} MB. Ask the vendor for a smaller file.`);
    start(f);
  };

  const all = useMemo(() => (live && !runs.some((r) => r.id === live.id) ? [live, ...runs] : runs), [live, runs]);

  const kpis = useMemo(() => {
    const done = all.filter((r) => r.status === "done");
    const decided = done.filter((r) => ["APPROVED", "HOLD", "REJECTED"].includes(view(r).decision?.decision ?? ""));
    const auto = decided.filter((r) => view(r).decision?.decision === "APPROVED").length;
    const held = done.filter((r) => effectiveDecision(r) === "HOLD").length;
    const stopped = done.filter((r) => ["HOLD", "REJECTED"].includes(effectiveDecision(r))).reduce((a, r) => a + (view(r).extracted?.total_amount ?? 0), 0);
    const times = done.map((r) => view(r).totalMs).filter((t): t is number => t != null && t > 1000).sort((a, b) => a - b);
    return {
      processed: done.length,
      autoPct: decided.length ? Math.round((auto / decided.length) * 100) + "%" : "—",
      held,
      stopped: stopped ? inr(stopped) : "—",
      median: times.length ? (times[Math.floor(times.length / 2)] / 1000).toFixed(1) + " s" : "—",
    };
  }, [all]);

  const open = openId ? (live && (live.id === openId) ? live : all.find((r) => r.id === openId)) : undefined;
  const pdfFor = (r: RunRecord) => localPdf.current[r.id] ?? (r.sampleFile ? `/samples/${r.sampleFile}` : r.status === "done" ? `/api/runs/${r.id}/pdf` : undefined);

  const reset = async () => {
    await fetch("/api/runs/reset", { method: "POST" });
    setOpenId(null);
    setNotice("Demo reset: all runs and emails cleared.");
    await refresh();
  };

  const override = async (id: string, decision: "APPROVED" | "REJECTED", reason: string) => {
    const res = await fetch(`/api/runs/${id}/override`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, reason }) });
    if (!res.ok) setNotice((await res.json().catch(() => ({}))).title ?? "Override failed");
    await refresh();
  };

  const go = (p: "home" | "db" | "rules") => { setOpenId(null); setPage(p); };
  const pageName = page === "rules" ? "Rules" : page === "db" ? "Database" : open ? (view(open).extracted?.invoice_number ?? open.fileName) : "Overview";
  const doneRuns = all.filter((r) => r.status === "done");
  const mix = (["APPROVED", "HOLD", "REJECTED"] as const).map((d) => doneRuns.filter((r) => effectiveDecision(r) === d).length);
  const other = doneRuns.length - mix[0] - mix[1] - mix[2];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sb-head">
          <div className="mark" aria-hidden>IF</div>
          <div><b>InvoiceFlow</b><span>Zamp Demo Buyer · AP</span></div>
        </div>
        <nav className="sb-nav" aria-label="Main">
          <button className={`nav-item ${page === "home" ? "on" : ""}`} aria-current={page === "home" ? "page" : undefined} onClick={() => go("home")}>
            <Icon d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />Overview
            {kpis.held > 0 && <span className="count" title="Waiting for review">{kpis.held}</span>}
          </button>
          <button className={`nav-item ${page === "rules" ? "on" : ""}`} aria-current={page === "rules" ? "page" : undefined} onClick={() => go("rules")}>
            <Icon d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />Rules
          </button>
          <button className={`nav-item ${page === "db" ? "on" : ""}`} aria-current={page === "db" ? "page" : undefined} onClick={() => go("db")}>
            <Icon d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />Database
          </button>
        </nav>
        <div className="sb-label">System</div>
        <div className="status-list">
          <div className="status-row"><span className={`sdot ${health?.ok ? "on" : "off"}`} />AI reader<b>{health ? (health.ok ? "on" : "off") : "…"}</b></div>
          <div className="status-row"><span className={`sdot ${health ? "on" : "off"}`} />Database<b>{health ? (health.database === "turso" ? "Turso" : "SQLite file") : "…"}</b></div>
          <div className="status-row"><span className={`sdot ${health?.email.configured ? "on" : "off"}`} />Email inbox<b>{health ? (health.email.configured ? "on" : "off") : "…"}</b></div>
          <div className="status-row"><span className={`sdot ${health?.ocr ? "on" : "off"}`} />LlamaParse OCR<b>{health ? (health.ocr ? "on" : "off") : "…"}</b></div>
        </div>
        <div className="sb-foot">
          <div className="sb-card">
            <div className="row"><b>Demo data</b><span className="num small muted">{doneRuns.length} runs</span></div>
            <div className="meter" aria-label={`${mix[0]} approved, ${mix[1]} held, ${mix[2]} rejected, ${other} other`}>
              {doneRuns.length > 0 && <>
                <i style={{ width: `${(mix[0] / doneRuns.length) * 100}%`, background: "#22a35a" }} />
                <i style={{ width: `${(mix[1] / doneRuns.length) * 100}%`, background: "#e0a540" }} />
                <i style={{ width: `${(mix[2] / doneRuns.length) * 100}%`, background: "var(--bad)" }} />
                <i style={{ width: `${(other / doneRuns.length) * 100}%`, background: "#b9b3a8" }} />
              </>}
            </div>
            <button className="btn" style={{ width: "100%" }} onClick={reset} disabled={!!live} title="Deletes all runs and emails from the database">Reset demo</button>
          </div>
        </div>
      </aside>

      <div className="main">
      <header className="header">
        <div className="crumbs">
          <span>InvoiceFlow</span><span aria-hidden>/</span>
          {open && page === "home" ? <><button className="btn link" onClick={() => setOpenId(null)}>Overview</button><span aria-hidden>/</span></> : null}
          <b>{pageName}</b>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {health?.email.configured && page === "home" && (
            <button className="btn" onClick={() => checkInbox(true)} disabled={checking}>
              <Icon d="M3 7l9 6 9-6M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z" />{checking ? "Checking…" : "Check inbox"}
            </button>
          )}
        </div>
      </header>

      <main className="content">
      {notice && (
        <div className="panel small" style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", gap: 8 }} role="status">
          <span>{notice}</span>
          <button className="btn link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {loadError && <div className="panel small" style={{ marginBottom: 16, color: "var(--bad)" }}>{loadError}</div>}

      {page === "rules" ? (
        <RulesView />
      ) : showDb ? (
        <DatabaseView />
      ) : open ? (
        <RunDetail run={open} pdfUrl={pdfFor(open)} onBack={() => setOpenId(null)} onOverride={(d, reason) => override(open.id, d, reason)} />
      ) : (
        <>
          <div className="page-title">
            <div>
              <h1>Overview</h1>
              <p>Invoice in → explained Approve / Hold / Reject out. The AI reads; the rules decide.</p>
            </div>
          </div>

          <section className="section kpis">
            <article className="panel kpi">
              <div className="label">Invoices processed</div>
              <div className="value num">{kpis.processed}</div>
              <div className="sub"><span className="delta">{all.filter((r) => r.source === "email").length} by email</span> · rest uploaded</div>
            </article>
            <article className="panel kpi">
              <div className="label">Auto-approved</div>
              <div className="value num">{kpis.autoPct}</div>
              <div className="sub"><span className="delta good">↗ {mix[0]} approved</span> no human needed</div>
            </article>
            <article className="panel kpi">
              <div className="label">Waiting for review</div>
              <div className="value num">{kpis.held}</div>
              <div className="sub"><span className={`delta ${kpis.held ? "warn" : "good"}`}>{kpis.held ? "! needs a person" : "✓ queue clear"}</span></div>
            </article>
            <article className="panel kpi">
              <div className="label">Value held or stopped</div>
              <div className="value num">{kpis.stopped}</div>
              <div className="sub"><span className="delta">⏱ {kpis.median}</span> median time to decision</div>
            </article>
          </section>

          <section className="section panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <h2>Runs</h2>
              <span className="small muted">Click a row to see the steps, checks and explanation</span>
            </div>
            {all.length === 0 ? (
              <div className="muted">No invoices processed yet. Try a sample below, upload one, or email one.</div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Time</th><th>Source</th><th>File</th><th>Vendor</th><th>Invoice</th><th>Total</th><th>Decision</th><th>Reason</th></tr></thead>
                  <tbody>
                    {all.map((r) => {
                      const v = view(r);
                      return (
                        <tr key={r.id} className="clickable" onClick={() => setOpenId(r.id)}>
                          <td className="num small">{new Date(r.startedAt).toLocaleTimeString("en-IN")}</td>
                          <td className="small">{r.source === "email" ? <span title={r.sender}>✉ Email</span> : "Upload"}</td>
                          <td className="small">{r.fileName}</td>
                          <td>{v.match?.vendorName ?? v.extracted?.vendor_name ?? "—"}</td>
                          <td className="mono small">{v.extracted?.invoice_number ?? "—"}</td>
                          <td className="num">{inr(v.extracted?.total_amount)}</td>
                          <td><Badge d={effectiveDecision(r)} />{r.override && <div className="small muted">override</div>}</td>
                          <td className="small">{v.decision?.headline.replace(/^(Held|Rejected|Approved): /, "") ?? "…"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="section split">
            <section className="panel">
              <h2>Upload an invoice</h2>
              <label
                className={`drop ${over ? "over" : ""}`}
                style={{ display: "block", cursor: "pointer" }}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
              >
                <input type="file" accept="application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" style={{ display: "none" }} onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
                <b>Drop a PDF or a photo here</b><br />or click to choose · PDF, JPG, PNG, WEBP · up to {MAX_MB} MB
              </label>
            </section>

            <section className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <h2>Email inbox</h2>
                {health?.email.configured && <span className="small muted">auto-checked every 30 s{lastCheck && <> · last {new Date(lastCheck).toLocaleTimeString("en-IN")}</>}</span>}
              </div>
              {health?.email.configured ? (
                <>
                  <div className="small muted" style={{ marginBottom: 10, overflowWrap: "anywhere" }}>
                    Email invoices (PDF or photo) to <b className="mono" style={{ color: "var(--ink)" }}>{health.email.address}</b>
                  </div>
                  <TrustedSenders />
                  {inbox.length === 0 ? <div className="muted small">No emails yet.</div> : (
                    <div className="tablewrap">
                      <table>
                        <thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Result</th></tr></thead>
                        <tbody>
                          {inbox.map((m) => (
                            <tr key={m.messageId}>
                              <td className="num small">{new Date(m.receivedAt).toLocaleTimeString("en-IN")}</td>
                              <td className="small mono">{m.sender}</td>
                              <td className="small">{m.subject}</td>
                              <td className="small"><span className={`pill ${m.status === "PROCESSED" ? "PASS" : ""}`}>{m.status === "NO_PDF" ? "No PDF" : "Processed"}</span> {m.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ) : (
                <div className="small muted">Email is not connected yet (set GMAIL_USER and GMAIL_APP_PASSWORD).</div>
              )}
            </section>
          </div>

          <section className="section">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <h2>Try a sample invoice</h2>
              <a className="small" href="/samples/all-test-invoices.zip" download>Download all test files (zip)</a>
            </div>
            {SAMPLE_GROUPS.map((g) => (
              <div key={g.title} style={{ marginBottom: 14 }}>
                <div className="sb-label" style={{ padding: "4px 0 8px" }}>{g.title}</div>
                <div className="samples">
                  {SAMPLES.filter((s) => g.ids.test(s.id)).map((s) => (
                    <button key={s.id} className="sample" onClick={() => runSample(s.file)} disabled={!!live}>
                      <span className="id"><i style={{ background: EXPECT_COLOR[s.expected] ?? "#b9b3a8" }} />{s.id} · expected: {s.expected}</span>
                      <span className="title">{s.title}</span>
                      <span className="shows">{s.shows}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="small muted">Tip: run S1 → S2 → S3 in order to see one PO split across invoices, then N1. Run H twice to see an exact duplicate.</div>
          </section>
        </>
      )}
      </main>
      </div>
    </div>
  );
}

const EXPECT_COLOR: Record<string, string> = { Approved: "#22a35a", Hold: "#e0a540", Reject: "#b42318" };
const SAMPLE_GROUPS = [
  { title: "Core checks", ids: /^(H|E\d)$/ },
  { title: "Splits, matching and tolerances", ids: /^(S\d|N1|T1|P\d|X1|A1|G1|U1)$/ },
  { title: "Dates, document type, currency and GST rate", ids: /^(D\d|C1|K1|F1|R1)$/ },
  { title: "Photos and scans (LlamaParse OCR)", ids: /^I\d$/ },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
