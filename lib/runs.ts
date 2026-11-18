// Run records (stored in the SQLite runs table) and the view derived from their event log.
import type { BurnDown, CheckResult, Decision, Extracted, FieldView, StageId, StageStatus, StreamEvent } from "./types";

export interface RunRecord {
  id: string;
  fileName: string;
  sampleFile?: string;
  source?: "upload" | "email";
  sender?: string;
  startedAt: number;
  status: "running" | "done";
  events: StreamEvent[];
  override?: { decision: "APPROVED" | "REJECTED"; reason: string; at: number };
}

export interface RunView {
  stages: Record<StageId, { status: StageStatus; ms?: number; note?: string }>;
  file?: { hash: string; pages: number; sizeKb: number; reader?: "pdf-text" | "llamaparse"; mime?: string };
  classified?: { isInvoice: boolean; docType: string; reason: string };
  fields?: FieldView[];
  extracted?: Extracted;
  match?: { vendorId?: string; vendorName?: string; poNumber?: string; burnDown?: BurnDown[] };
  checks?: CheckResult[];
  decision?: { decision: Decision; headline: string; action?: string; rulesVersion?: number };
  summary?: { text: string; source: "ai" | "auto" };
  error?: string;
  totalMs?: number;
}

export function view(run: RunRecord): RunView {
  const v: RunView = {
    stages: {
      file_check: { status: "pending" }, classify: { status: "pending" }, extract: { status: "pending" },
      match: { status: "pending" }, validate: { status: "pending" }, decide: { status: "pending" },
    },
  };
  for (const e of run.events) {
    switch (e.type) {
      case "stage": v.stages[e.stage] = { status: e.status, ms: e.ms ?? v.stages[e.stage].ms, note: e.note }; break;
      case "file": v.file = e; break;
      case "classified": v.classified = e; break;
      case "fields": v.fields = e.fields; v.extracted = e.extracted; break;
      case "match": v.match = e; break;
      case "checks": v.checks = e.checks; break;
      case "decision": v.decision = e; break;
      case "summary": v.summary = e; break;
      case "error": v.error = e.message; break;
      case "done": v.totalMs = e.totalMs; break;
    }
  }
  return v;
}

export function effectiveDecision(run: RunRecord): Decision | "RUNNING" {
  if (run.override) return run.override.decision;
  return view(run).decision?.decision ?? (run.status === "running" ? "RUNNING" : "ERROR");
}

export const LABEL: Record<string, string> = {
  APPROVED: "Approved", HOLD: "Hold for review", REJECTED: "Rejected", IGNORED: "Not an invoice",
  STOPPED: "Stopped safely", ERROR: "System error", RUNNING: "Running…",
};
export const ICON: Record<string, string> = {
  APPROVED: "✓", HOLD: "!", REJECTED: "✕", IGNORED: "–", STOPPED: "■", ERROR: "⚠", RUNNING: "…",
};
