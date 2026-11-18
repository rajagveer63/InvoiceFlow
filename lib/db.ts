// SQLite database (libSQL). Local file `database/invoice_demo.db` by default; Turso when DATABASE_URL is set.
import fs from "node:fs";
import { createClient, type Client, type InValue } from "@libsql/client";
import { PURCHASE_ORDERS, VENDORS, type PurchaseOrder, type Vendor } from "./data";
import { effectiveDecision, view, type RunRecord } from "./runs";
import type { PriorRun, StreamEvent } from "./types";
import { alreadyBilled } from "./checks";
import { DEFAULT_RULE_SET, type RuleSet, type RuleSettings } from "./rules";

let client: Client | null = null;
let ready: Promise<void> | null = null;

function db(): Client {
  if (!client) {
    const url = process.env.DATABASE_URL || "file:database/invoice_demo.db";
    if (url.startsWith("file:")) fs.mkdirSync("database", { recursive: true });
    client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
  }
  return client;
}

export function dbKind(): "turso" | "local-file" {
  return (process.env.DATABASE_URL ?? "").startsWith("libsql:") ? "turso" : "local-file";
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vendors (id TEXT PRIMARY KEY, name TEXT NOT NULL, gstin TEXT NOT NULL, state TEXT NOT NULL, status TEXT NOT NULL, email_domain TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS purchase_orders (number TEXT PRIMARY KEY, vendor_id TEXT NOT NULL REFERENCES vendors(id), status TEXT NOT NULL, currency TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS po_lines (po_number TEXT NOT NULL REFERENCES purchase_orders(number), item_code TEXT NOT NULL, description TEXT NOT NULL, qty INTEGER NOT NULL, unit_price REAL NOT NULL, PRIMARY KEY (po_number, item_code))`,
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY, file_name TEXT NOT NULL, sample_file TEXT, source TEXT NOT NULL DEFAULT 'upload',
     sender TEXT, message_id TEXT, attachment_index INTEGER, started_at INTEGER NOT NULL, status TEXT NOT NULL,
     decision TEXT, effective_decision TEXT, file_hash TEXT, vendor_id TEXT, invoice_number TEXT, po_number TEXT,
     total REAL, lines TEXT, events TEXT NOT NULL DEFAULT '[]', override TEXT, pdf BLOB)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS runs_email_once ON runs(message_id, attachment_index) WHERE message_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS db_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, table_name TEXT NOT NULL, action TEXT NOT NULL, summary TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rule_versions (version INTEGER PRIMARY KEY, settings TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS trusted_senders (email TEXT PRIMARY KEY, vendor_id TEXT, note TEXT, added_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS inbound_messages (
     message_id TEXT PRIMARY KEY, sender TEXT, subject TEXT, received_at INTEGER NOT NULL, status TEXT NOT NULL, note TEXT)`,
];

export function init(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const c = db();
      await c.batch(SCHEMA, "write");
      const n = await c.execute("SELECT COUNT(*) AS n FROM vendors");
      if (Number(n.rows[0].n) === 0) await seedMaster();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function seedMaster() {
  const stmts: { sql: string; args: InValue[] }[] = [];
  for (const v of VENDORS) stmts.push({ sql: "INSERT OR REPLACE INTO vendors VALUES (?,?,?,?,?,?)", args: [v.id, v.name, v.gstin, v.state, v.status, v.emailDomain] });
  for (const p of PURCHASE_ORDERS) {
    stmts.push({ sql: "INSERT OR REPLACE INTO purchase_orders VALUES (?,?,?,?)", args: [p.number, p.vendorId, p.status, p.currency] });
    for (const l of p.lines) stmts.push({ sql: "INSERT OR REPLACE INTO po_lines VALUES (?,?,?,?,?)", args: [p.number, l.itemCode, l.description, l.qty, l.unitPrice] });
  }
  await db().batch(stmts, "write");
}

export async function loadMaster(): Promise<{ vendors: Vendor[]; pos: PurchaseOrder[]; trustedSenders: { email: string; vendorId?: string }[] }> {
  await init();
  const [v, p, l] = await Promise.all([
    db().execute("SELECT * FROM vendors"),
    db().execute("SELECT * FROM purchase_orders"),
    db().execute("SELECT * FROM po_lines"),
  ]);
  const t = await db().execute("SELECT email, vendor_id FROM trusted_senders");
  const trustedSenders = t.rows.map((r) => ({ email: String(r.email).toLowerCase(), vendorId: r.vendor_id ? String(r.vendor_id) : undefined }));
  const vendors: Vendor[] = v.rows.map((r) => ({
    id: String(r.id), name: String(r.name), gstin: String(r.gstin), state: String(r.state),
    status: String(r.status) as Vendor["status"], emailDomain: String(r.email_domain),
  }));
  const pos: PurchaseOrder[] = p.rows.map((r) => ({
    number: String(r.number), vendorId: String(r.vendor_id), status: String(r.status) as PurchaseOrder["status"], currency: "INR",
    lines: l.rows.filter((x) => x.po_number === r.number).map((x) => ({
      itemCode: String(x.item_code), description: String(x.description), qty: Number(x.qty), unitPrice: Number(x.unit_price),
    })),
  }));
  return { vendors, pos, trustedSenders };
}

export interface NewRun {
  id: string; fileName: string; sampleFile?: string; source: "upload" | "email";
  sender?: string; messageId?: string; attachmentIndex?: number; pdf: Uint8Array;
}

/** Inserts a RUNNING row. For email, returns false if this attachment was already taken (idempotent ingest). */
export async function createRun(r: NewRun): Promise<boolean> {
  await init();
  try {
    await db().execute({
      sql: `INSERT INTO runs (id, file_name, sample_file, source, sender, message_id, attachment_index, started_at, status, pdf)
            VALUES (?,?,?,?,?,?,?,?, 'running', ?)`,
      args: [r.id, r.fileName, r.sampleFile ?? null, r.source, r.sender ?? null, r.messageId ?? null, r.attachmentIndex ?? null, Date.now(), r.pdf],
    });
    await logChange("runs", "INSERT", `New run for ${r.fileName} (${r.source === "email" ? `emailed by ${r.sender}` : "uploaded"}), PDF stored`);
    return true;
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) return false;
    throw e;
  }
}

export async function finishRun(id: string, events: StreamEvent[]) {
  const rec = { id, fileName: "", startedAt: 0, status: "done", events } as RunRecord;
  const v = view(rec);
  await db().execute({
    sql: `UPDATE runs SET status='done', events=?, decision=?, effective_decision=?, file_hash=?, vendor_id=?, invoice_number=?,
          po_number=?, total=?, lines=? WHERE id=?`,
    args: [
      JSON.stringify(events), v.decision?.decision ?? "ERROR", v.decision?.decision ?? "ERROR", v.file?.hash ?? null,
      v.match?.vendorId ?? null, v.extracted?.invoice_number ?? null, v.match?.poNumber ?? null, v.extracted?.total_amount ?? null,
      JSON.stringify((v.match?.burnDown ?? []).map((b) => ({ itemCode: b.itemCode, qty: b.thisInvoice }))), id,
    ],
  });
  const d = v.decision?.decision ?? "ERROR";
  const billed = d === "APPROVED" && v.match?.burnDown?.length
    ? `; ${v.match.poNumber} draw-down: ${v.match.burnDown.map((b) => `${b.itemCode} −${b.thisInvoice}`).join(", ")}` : "";
  await logChange("runs", "UPDATE", `Decision ${d}${v.extracted?.invoice_number ? ` for ${v.extracted.invoice_number}` : ""}${v.match?.vendorName ? ` (${v.match.vendorName})` : ""}${billed}`);
}

/** Trusted email senders (editable from the dashboard so a tester can add their own address). */
export async function listSenders(): Promise<{ email: string; note: string; addedAt: number }[]> {
  await init();
  const r = await db().execute("SELECT email, note, added_at FROM trusted_senders WHERE vendor_id IS NULL OR vendor_id = '' ORDER BY added_at");
  return r.rows.map((x) => ({ email: String(x.email), note: x.note ? String(x.note) : "", addedAt: Number(x.added_at) }));
}

export async function addSender(email: string, note: string): Promise<"added" | "exists" | "full"> {
  await init();
  const n = await db().execute("SELECT COUNT(*) AS n FROM trusted_senders");
  if (Number(n.rows[0].n) >= 25) return "full";
  const r = await db().execute({ sql: "INSERT OR IGNORE INTO trusted_senders (email, vendor_id, note, added_at) VALUES (?, NULL, ?, ?)", args: [email, note, Date.now()] });
  if (!r.rowsAffected) return "exists";
  await logChange("trusted_senders", "INSERT", `Trusted sender added: ${email} (may email invoices for any vendor)`);
  return "added";
}

export async function removeSender(email: string): Promise<boolean> {
  await init();
  const r = await db().execute({ sql: "DELETE FROM trusted_senders WHERE email = ?", args: [email] });
  if (r.rowsAffected) await logChange("trusted_senders", "DELETE", `Trusted sender removed: ${email}`);
  return r.rowsAffected > 0;
}

async function logChange(table: string, action: string, summary: string) {
  try {
    await db().execute({ sql: "INSERT INTO db_changes (at, table_name, action, summary) VALUES (?,?,?,?)", args: [Date.now(), table, action, summary.slice(0, 300)] });
  } catch { /* the change log never blocks a run */ }
}

/** Whole database for the in-app Database page: every table, every column, newest rows first (max 200 per table). */
const DB_TABLES: { name: string; about: string; sql: string }[] = [
  { name: "db_changes", about: "Log of every write the app makes", sql: "SELECT id, at, table_name, action, summary FROM db_changes ORDER BY id DESC LIMIT 200" },
  { name: "runs", about: "One row per processed invoice (PDF stored as a BLOB)", sql: `SELECT id, started_at, source, sender, file_name, status, decision, effective_decision, vendor_id, invoice_number, po_number, total, lines, override, file_hash, message_id, length(pdf) AS pdf_bytes, length(events) AS events_bytes FROM runs ORDER BY started_at DESC LIMIT 200` },
  { name: "inbound_messages", about: "Emails read from the Gmail inbox", sql: "SELECT * FROM inbound_messages ORDER BY received_at DESC LIMIT 200" },
  { name: "vendors", about: "Vendor master", sql: "SELECT * FROM vendors ORDER BY id" },
  { name: "purchase_orders", about: "Purchase orders", sql: "SELECT * FROM purchase_orders ORDER BY number" },
  { name: "po_lines", about: "PO lines (ordered quantity and agreed price)", sql: "SELECT * FROM po_lines ORDER BY po_number, item_code" },
  { name: "trusted_senders", about: "Email addresses trusted to send invoices", sql: "SELECT * FROM trusted_senders ORDER BY email" },
  { name: "rule_versions", about: "Every saved version of the editable rules", sql: "SELECT version, created_at, reason, settings FROM rule_versions ORDER BY version DESC LIMIT 200" },
];

export async function dbDump() {
  await init();
  const [results, counts, master, prior] = await Promise.all([
    db().batch(DB_TABLES.map((t) => t.sql), "read"),
    db().batch(DB_TABLES.map((t) => `SELECT COUNT(*) AS n FROM ${t.name}`), "read"),
    loadMaster(), priorRuns(),
  ]);
  const cell = (v: unknown) => (typeof v === "bigint" ? Number(v) : v instanceof ArrayBuffer ? `<${v.byteLength} bytes>` : v);
  const tables = DB_TABLES.map((t, i) => ({
    name: t.name, about: t.about, total: Number(counts[i].rows[0].n), columns: results[i].columns,
    rows: results[i].rows.map((r) => results[i].columns.map((c) => cell((r as Record<string, unknown>)[c]))),
  }));
  const poBalances = master.pos.flatMap((p) => p.lines.map((l) => {
    const billed = alreadyBilled(p.number, l.itemCode, prior);
    return { po: p.number, vendor: master.vendors.find((v) => v.id === p.vendorId)?.name ?? p.vendorId, item: l.itemCode, ordered: l.qty, billed, left: l.qty - billed };
  }));
  return { kind: dbKind(), tables, poBalances };
}

function rowToRecord(r: Record<string, unknown>): RunRecord {
  return {
    id: String(r.id), fileName: String(r.file_name), sampleFile: r.sample_file ? String(r.sample_file) : undefined,
    source: (r.source as RunRecord["source"]) ?? "upload", sender: r.sender ? String(r.sender) : undefined,
    startedAt: Number(r.started_at), status: r.status === "running" ? "running" : "done",
    events: JSON.parse(String(r.events ?? "[]")), override: r.override ? JSON.parse(String(r.override)) : undefined,
  };
}

export async function listRuns(limit = 100): Promise<RunRecord[]> {
  await init();
  const res = await db().execute({
    sql: `SELECT id, file_name, sample_file, source, sender, started_at, status, events, override FROM runs ORDER BY started_at DESC LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((r) => rowToRecord(r as unknown as Record<string, unknown>));
}

export async function getPdf(id: string): Promise<Uint8Array | null> {
  await init();
  const res = await db().execute({ sql: "SELECT pdf FROM runs WHERE id=?", args: [id] });
  const pdf = res.rows[0]?.pdf;
  if (!pdf) return null;
  return pdf instanceof ArrayBuffer ? new Uint8Array(pdf) : new Uint8Array(pdf as unknown as ArrayLike<number>);
}

export async function setOverride(id: string, decision: "APPROVED" | "REJECTED", reason: string): Promise<boolean> {
  await init();
  const res = await db().execute({
    sql: `UPDATE runs SET override=?, effective_decision=? WHERE id=? AND decision='HOLD' AND override IS NULL`,
    args: [JSON.stringify({ decision, reason, at: Date.now() }), decision, id],
  });
  if (res.rowsAffected === 1) await logChange("runs", "UPDATE", `Reviewer override → ${decision}: "${reason}"`);
  return res.rowsAffected === 1;
}

export async function loadRules(): Promise<RuleSet> {
  await init();
  const r = await db().execute("SELECT version, settings, reason, created_at FROM rule_versions ORDER BY version DESC LIMIT 1");
  if (!r.rows.length) return DEFAULT_RULE_SET;
  const row = r.rows[0];
  return { ...DEFAULT_RULE_SET, ...JSON.parse(String(row.settings)), version: Number(row.version), reason: String(row.reason), createdAt: Number(row.created_at) };
}

export async function ruleHistory(limit = 20): Promise<RuleSet[]> {
  await init();
  const r = await db().execute({ sql: "SELECT version, settings, reason, created_at FROM rule_versions ORDER BY version DESC LIMIT ?", args: [limit] });
  return r.rows.map((row) => ({ ...DEFAULT_RULE_SET, ...JSON.parse(String(row.settings)), version: Number(row.version), reason: String(row.reason), createdAt: Number(row.created_at) }));
}

/** Saves a new rule version (versions are never edited in place) and logs what changed. */
export async function saveRules(next: RuleSettings, reason: string): Promise<RuleSet> {
  const cur = await loadRules();
  const version = cur.version + 1;
  const diff: string[] = [];
  for (const k of ["linePricePct", "linePriceCapInr", "qtyTolerancePct", "arithmeticToleranceInr", "nearDupToleranceInr", "maxInvoiceAgeDays"] as const)
    if (cur[k] !== next[k]) diff.push(`${k} ${cur[k]} → ${next[k]}`);
  const ids = new Set([...Object.keys(cur.checks ?? {}), ...Object.keys(next.checks)]);
  ids.forEach((id) => { const a = cur.checks?.[id] ?? "default", b = next.checks[id] ?? "default"; if (a !== b) diff.push(`${id} ${a} → ${b}`); });
  await db().execute({ sql: "INSERT INTO rule_versions VALUES (?,?,?,?)", args: [version, JSON.stringify(next), reason, Date.now()] });
  await logChange("rule_versions", "INSERT", `Rule set v${version}: ${diff.join("; ") || "no setting changed"} (reason: ${reason})`);
  return { ...next, version, reason, createdAt: Date.now() };
}

export async function resetAll() {
  await init();
  const n = await db().execute("SELECT COUNT(*) AS n FROM runs");
  await db().batch(["DELETE FROM runs", "DELETE FROM inbound_messages"], "write");
  await logChange("runs", "DELETE", `Demo reset: ${Number(n.rows[0].n)} runs and the email log deleted (vendors, POs and trusted senders kept)`);
}

export async function priorRuns(): Promise<PriorRun[]> {
  await init();
  const res = await db().execute(
    `SELECT file_hash, vendor_id, invoice_number, po_number, effective_decision, lines, total FROM runs WHERE status='done' AND file_hash IS NOT NULL ORDER BY started_at DESC LIMIT 500`);
  return res.rows.map((r) => ({
    fileHash: String(r.file_hash), vendorId: r.vendor_id ? String(r.vendor_id) : undefined,
    invoiceNumber: r.invoice_number ? String(r.invoice_number) : undefined, poNumber: r.po_number ? String(r.po_number) : undefined,
    effectiveDecision: String(r.effective_decision) as PriorRun["effectiveDecision"], lines: JSON.parse(String(r.lines ?? "[]")),
    total: r.total == null ? undefined : Number(r.total),
  }));
}

export async function logInbound(messageId: string, sender: string, subject: string, status: string, note: string) {
  await init();
  await db().execute({
    sql: `INSERT OR REPLACE INTO inbound_messages VALUES (?,?,?,?,?,?)`,
    args: [messageId, sender, subject, Date.now(), status, note],
  });
  await logChange("inbound_messages", "INSERT", `Email from ${sender}: "${subject}" → ${note}`);
}

export async function listInbound(limit = 20) {
  await init();
  const res = await db().execute({ sql: `SELECT * FROM inbound_messages ORDER BY received_at DESC LIMIT ?`, args: [limit] });
  return res.rows.map((r) => ({
    messageId: String(r.message_id), sender: String(r.sender ?? ""), subject: String(r.subject ?? ""),
    receivedAt: Number(r.received_at), status: String(r.status), note: String(r.note ?? ""),
  }));
}

export { effectiveDecision };
