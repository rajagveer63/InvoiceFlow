"use client";
import { useEffect, useState } from "react";

interface Sender { email: string; note: string; addedAt: number }

/** Lets a tester add their own email so invoices they send pass the "Email sender matches the vendor" check. */
export default function TrustedSenders() {
  const [senders, setSenders] = useState<Sender[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/senders", { cache: "no-store" }).then((r) => r.json()).then((d) => setSenders(d.senders ?? [])).catch(() => setSenders([]));
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/senders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.title);
      setSenders(d.senders);
      setMsg({ ok: true, text: d.status === "exists" ? `${email.trim().toLowerCase()} is already trusted.` : `Added. Invoices emailed from ${email.trim().toLowerCase()} will now pass the sender check.` });
      setEmail("");
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (addr: string) => {
    setBusy(true); setMsg(null);
    try {
      const d = await (await fetch(`/api/senders?email=${encodeURIComponent(addr)}`, { method: "DELETE" })).json();
      setSenders(d.senders);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="senders">
      <div className="small"><b>Testing by email?</b> <span className="muted">Add the address you will send from. Without it, the invoice is still processed but held as “sender does not match the vendor”.</span></div>
      <form className="sender-form" onSubmit={add}>
        <input className="search" type="email" required placeholder="your.email@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Your email address" />
        <button className="btn primary" disabled={busy || !email.trim()}>Add as trusted sender</button>
      </form>
      {msg && <div className="small" role="status" style={{ color: msg.ok ? "var(--ok)" : "var(--bad)" }}>{msg.text}</div>}
      <div className="chips" style={{ marginTop: 8 }}>
        {senders === null ? <span className="small muted">Loading…</span>
          : senders.length === 0 ? <span className="small muted">No trusted senders yet.</span>
          : senders.map((s) => (
            <span key={s.email} className="chip mono sender-chip" title={s.note}>
              {s.email}
              <button type="button" aria-label={`Remove ${s.email}`} onClick={() => remove(s.email)} disabled={busy}>×</button>
            </span>
          ))}
      </div>
    </div>
  );
}
