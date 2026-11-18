"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface Table { name: string; about: string; total: number; columns: string[]; rows: unknown[][] }
interface PoBalance { po: string; vendor: string; item: string; ordered: number; billed: number; left: number }
interface Dump { kind: string; tables: Table[]; poBalances: PoBalance[] }

const TIME_COLS = new Set(["at", "started_at", "received_at", "added_at"]);
const REFRESH_MS = 5000;

function show(col: string, v: unknown): string {
  if (v == null) return "—";
  if (TIME_COLS.has(col) && typeof v === "number") return new Date(v).toLocaleString("en-IN", { hour12: false });
  if (col === "total" && typeof v === "number") return "₹" + v.toLocaleString("en-IN");
  return String(v);
}

export default function DatabaseView() {
  const [data, setData] = useState<Dump | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("db_changes");
  const [fresh, setFresh] = useState<Set<string>>(new Set()); // "table:firstCell" of rows that appeared since the last refresh
  const seen = useRef<Map<string, Set<string>> | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/db", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.detail ?? d.title);
      const now = new Map<string, Set<string>>();
      const added = new Set<string>();
      for (const t of d.tables as Table[]) {
        const keys = new Set(t.rows.map((r) => String(r[0])));
        now.set(t.name, keys);
        const before = seen.current?.get(t.name);
        if (before) keys.forEach((k) => { if (!before.has(k)) added.add(`${t.name}:${k}`); });
      }
      seen.current = now;
      setFresh(added);
      setData(d);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="panel" style={{ color: "var(--bad)" }}>Could not read the database: {error}</div>;
  if (!data) return <div className="panel muted">Loading database…</div>;

  const table = data.tables.find((t) => t.name === tab);

  return (
    <div>
      <section className="section panel">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Database</h2>
          <span className="small muted">
            {data.kind === "turso" ? "SQLite on Turso (online)" : "Local SQLite file database/invoice_demo.db"} · refreshes every 5 s
            {updatedAt && <> · updated {new Date(updatedAt).toLocaleTimeString("en-IN")}</>}
            {" "}<button className="btn link" onClick={load}>Refresh now</button>
          </span>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          Every table the app uses, read live. New rows are highlighted. Process an invoice in another tab and watch the rows appear.
        </div>
        <div className="dbtabs" role="tablist">
          {data.tables.map((t) => (
            <button key={t.name} role="tab" aria-selected={tab === t.name} className={`dbtab ${tab === t.name ? "on" : ""}`} onClick={() => setTab(t.name)}>
              <span className="mono">{t.name === "db_changes" ? "Changes log" : t.name}</span> <span className="count">{t.total}</span>
            </button>
          ))}
          <button role="tab" aria-selected={tab === "po_balance"} className={`dbtab ${tab === "po_balance" ? "on" : ""}`} onClick={() => setTab("po_balance")}>
            PO balances
          </button>
        </div>
      </section>

      {tab === "po_balance" ? (
        <section className="section panel">
          <h2>PO balances <span className="muted small">(computed: ordered − already approved, including earlier history)</span></h2>
          <div className="tablewrap">
            <table>
              <thead><tr><th>PO</th><th>Vendor</th><th>Item</th><th>Ordered</th><th>Billed</th><th>Left</th><th>Used</th></tr></thead>
              <tbody>
                {data.poBalances.map((b) => (
                  <tr key={b.po + b.item}>
                    <td className="mono">{b.po}</td><td>{b.vendor}</td><td className="mono small">{b.item}</td>
                    <td className="num">{b.ordered}</td><td className="num">{b.billed}</td>
                    <td className="num" style={{ color: b.left <= 0 ? "var(--bad)" : undefined, fontWeight: 600 }}>{b.left}</td>
                    <td style={{ minWidth: 120 }}>
                      <div className="bar" style={{ height: 10 }}><div className="used" style={{ width: `${Math.min(100, (b.billed / b.ordered) * 100)}%` }} /></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : table && (
        <section className="section panel">
          <h2>
            <span className="mono">{table.name}</span>{" "}
            <span className="muted small">{table.about} · {table.total} row{table.total === 1 ? "" : "s"}{table.total > table.rows.length ? ` (newest ${table.rows.length} shown)` : ""}</span>
          </h2>
          {table.rows.length === 0 ? <div className="muted">This table is empty.</div> : (
            <div className="tablewrap">
              <table className="dbtable">
                <thead><tr>{table.columns.map((c) => <th key={c} className="mono">{c}</th>)}</tr></thead>
                <tbody>
                  {table.rows.map((r) => {
                    const isNew = fresh.has(`${table.name}:${String(r[0])}`);
                    return (
                      <tr key={String(r[0])} className={isNew ? "fresh" : ""}>
                        {r.map((v, i) => {
                          const txt = show(table.columns[i], v);
                          return <td key={i} title={txt.length > 60 ? txt : undefined} className="small">{txt.length > 60 ? txt.slice(0, 60) + "…" : txt}</td>;
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
