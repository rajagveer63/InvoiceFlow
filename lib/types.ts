export type StageId = "file_check" | "classify" | "extract" | "match" | "validate" | "decide";

export const STAGES: { id: StageId; label: string }[] = [
  { id: "file_check", label: "File check" },
  { id: "classify", label: "Classify" },
  { id: "extract", label: "Extract" },
  { id: "match", label: "Match PO" },
  { id: "validate", label: "Validate" },
  { id: "decide", label: "Decide" },
];

export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type Decision = "APPROVED" | "HOLD" | "REJECTED" | "IGNORED" | "STOPPED" | "ERROR";

export interface ExtractedLine {
  item_code: string | null;
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
}

export interface Extracted {
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  vendor_name: string | null;
  vendor_gstin: string | null;
  buyer_name: string | null;
  buyer_gstin: string | null;
  po_number: string | null;
  currency: string | null;
  subtotal: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  total_amount: number | null;
  lines: ExtractedLine[];
}

export interface FieldView {
  key: string;
  label: string;
  value: string;
  found: boolean; // value located in the PDF text
}

export type CheckOutcome = "PASS" | "FAIL" | "SKIPPED";

export interface CheckResult {
  id: string;
  label: string;
  result: CheckOutcome;
  onFail: "HOLD" | "REJECT";
  expected: string;
  actual: string;
  explanation: string;
}

export interface PriorRun {
  fileHash: string;
  vendorId?: string;
  invoiceNumber?: string;
  poNumber?: string;
  effectiveDecision: Decision; // includes manual override
  lines?: { itemCode: string; qty: number }[];
  total?: number;
}

export interface BurnDown {
  poNumber: string;
  itemCode: string;
  description: string;
  ordered: number;
  alreadyBilled: number;
  thisInvoice: number;
}

export type StreamEvent =
  | { type: "run"; id: string }
  | { type: "stage"; stage: StageId; status: StageStatus; ms?: number; note?: string }
  | { type: "file"; hash: string; pages: number; sizeKb: number; reader?: "pdf-text" | "llamaparse"; mime?: string }
  | { type: "classified"; isInvoice: boolean; docType: string; reason: string }
  | { type: "fields"; fields: FieldView[]; extracted: Extracted }
  | { type: "match"; vendorId?: string; vendorName?: string; poNumber?: string; burnDown?: BurnDown[] }
  | { type: "checks"; checks: CheckResult[] }
  | { type: "decision"; decision: Decision; headline: string; action?: string; rulesVersion?: number }
  | { type: "summary"; text: string; source: "ai" | "auto" }
  | { type: "error"; message: string }
  | { type: "done"; totalMs: number };
