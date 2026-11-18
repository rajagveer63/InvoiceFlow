// Generates the demo invoice PDFs into public/samples. Run: node scripts/make-samples.ts
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { BUYER, VENDORS } from "../lib/data.ts";
import { gstinCheckChar } from "../lib/gstin.ts";

interface Line { code: string; desc: string; qty: number; price: number }
interface Inv {
  file: string; vendorId: string; gstinOverride?: string; number: string; date: string; due: string;
  po?: string; lines: Line[]; totalOverride?: number;
  vendor?: { name: string; gstin: string; emailDomain: string }; // a vendor that is NOT in the master data
  taxMode?: "IGST" | "CGST_SGST"; // force the wrong tax type
  title?: string; // printed title (default TAX INVOICE)
  currency?: "USD"; // print amounts in another currency
  taxRate?: number; // GST % (default 18)
  note?: string; // extra line under the header
}

const OUT = path.join(import.meta.dirname, "..", "public", "samples");
fs.mkdirSync(OUT, { recursive: true });

const rs = (n: number) => "Rs. " + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function invoicePdf(inv: Inv): Promise<Uint8Array> {
  const v = inv.vendor ?? VENDORS.find((x) => x.id === inv.vendorId)!;
  const inr = (n: number) => inv.currency ? `${inv.currency} ` + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : rs(n);
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const b = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const t = (s: string, x: number, size = 10, font = f) => page.drawText(s, { x, y, size, font, color: rgb(0.1, 0.1, 0.12) });
  t(v.name, 40, 16, b); t(inv.title ?? "TAX INVOICE", inv.title ? 390 : 430, 14, b); y -= 18;
  t(`GSTIN: ${inv.gstinOverride ?? v.gstin}`, 40); y -= 14;
  t(`billing@${v.emailDomain}`, 40); y -= 30;
  t(`Invoice No: ${inv.number}`, 40, 11, b); t(`Invoice Date: ${inv.date}`, 330, 11); y -= 16;
  t(`PO Number: ${inv.po ?? "-"}`, 40, 11); t(`Due Date: ${inv.due}`, 330, 11); y -= 16;
  if (inv.currency) { t(`Currency: ${inv.currency}`, 40, 11); y -= 16; }
  if (inv.note) { t(inv.note, 40, 10); y -= 16; }
  y -= 14;
  t("Bill To:", 40, 10, b); y -= 14;
  t(BUYER.name, 40); y -= 13; t(BUYER.address, 40); y -= 13; t(`GSTIN: ${BUYER.gstin}`, 40); y -= 30;
  page.drawRectangle({ x: 36, y: y - 4, width: 523, height: 18, color: rgb(0.92, 0.95, 0.95) });
  t("Item Code", 40, 10, b); t("Description", 120, 10, b); t("Qty", 340, 10, b); t("Unit Price", 380, 10, b); t("Amount", 480, 10, b);
  y -= 22;
  let subtotal = 0;
  for (const l of inv.lines) {
    const amt = l.qty * l.price; subtotal += amt;
    t(l.code, 40); t(l.desc, 120); t(String(l.qty), 345); t(inr(l.price), 380); t(inr(amt), 480); y -= 18;
  }
  y -= 14;
  const intra = inv.taxMode ? inv.taxMode === "CGST_SGST" : (inv.gstinOverride ?? v.gstin).slice(0, 2) === BUYER.state;
  const rate = inv.taxRate ?? 18;
  const tax = Math.round(subtotal * rate) / 100;
  const total = inv.totalOverride ?? subtotal + tax;
  t("Subtotal", 380); t(inr(subtotal), 480); y -= 16;
  if (intra) {
    t(`CGST @ ${rate / 2}%`, 380); t(inr(tax / 2), 480); y -= 16;
    t(`SGST @ ${rate / 2}%`, 380); t(inr(tax / 2), 480); y -= 16;
  } else {
    t(`IGST @ ${rate}%`, 380); t(inr(tax), 480); y -= 16;
  }
  t("Grand Total", 380, 11, b); t(inr(total), 480, 11, b); y -= 40;
  t("Payment terms: Net 30. Bank: HDFC Bank, A/c 50200012345678, IFSC HDFC0000123", 40, 9);
  return doc.save();
}

async function letterPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const b = await doc.embedFont(StandardFonts.HelveticaBold);
  const lines = [
    "Dear Accounts Team,", "",
    "This is a friendly reminder that invoice INV-DL-2190 dated 02 Oct 2026",
    "remains unpaid. We would be grateful if you could arrange payment at",
    "your earliest convenience. Please ignore this note if payment has",
    "already been made.", "", "Regards,", "Receivables Desk, Dell India Pvt Ltd",
  ];
  page.drawText("Payment Reminder", { x: 40, y: 790, size: 16, font: b });
  lines.forEach((s, i) => page.drawText(s, { x: 40, y: 750 - i * 16, size: 11, font: f }));
  return doc.save();
}

const invoices: Inv[] = [
  { file: "H-dell-clean.pdf", vendorId: "V001", number: "INV-DL-2201", date: "05/11/2026", due: "05/12/2026", po: "PO-501",
    lines: [{ code: "LAT-5440", desc: "Dell Latitude 5440 laptop", qty: 2, price: 75000 }] },
  { file: "E1-dell-po-overrun.pdf", vendorId: "V001", number: "INV-DL-2207", date: "14/10/2026", due: "13/11/2026", po: "PO-504",
    lines: [{ code: "MON-P2423", desc: "Dell P2423 24-inch monitor", qty: 2, price: 15000 }] },
  { file: "E4-hp-price-over.pdf", vendorId: "V002", number: "INV-HP-0931", date: "23/10/2026", due: "22/11/2026", po: "PO-502",
    lines: [{ code: "PRN-M404", desc: "HP LaserJet Pro M404dn printer", qty: 3, price: 23100 }] },
  { file: "E6-dell-wrong-gstin.pdf", vendorId: "V001", gstinOverride: "29AAACD3424N1ZK", number: "INV-DL-2215", date: "28/09/2026", due: "28/10/2026", po: "PO-505",
    lines: [{ code: "DOCK-WD19", desc: "Dell WD19 docking station", qty: 2, price: 18000 }] },
  { file: "E8-blocked-vendor.pdf", vendorId: "V003", number: "AT/26/0412", date: "09/09/2026", due: "09/10/2026", po: "PO-508",
    lines: [{ code: "CHR-ERG", desc: "Ergonomic office chair", qty: 4, price: 9000 }] },
  { file: "E5-dell-locked.src.pdf", vendorId: "V001", number: "INV-DL-2222", date: "17/08/2026", due: "16/09/2026", po: "PO-501",
    lines: [{ code: "LAT-5440", desc: "Dell Latitude 5440 laptop", qty: 1, price: 75000 }] },
];

// Second set: one PDF per rule in the case brief. Run them in this order (S1 -> S2 -> S3, then N1).
const sharmaBase = "29AAPFS7788L1Z";
const LAPTOP = { code: "LAT-5440", desc: "Dell Latitude 5440 laptop", price: 75000 };
const DOCK = { code: "DOCK-WD19", desc: "Dell WD19 docking station", price: 18000 };
invoices.push(
  { file: "S1-dell-split-part1.pdf", vendorId: "V001", number: "INV-DL-2231", date: "06/11/2026", due: "06/12/2026", po: "PO-501",
    lines: [{ ...LAPTOP, qty: 3 }] },
  { file: "S2-dell-split-part2.pdf", vendorId: "V001", number: "INV-DL-2232", date: "10/11/2026", due: "10/12/2026", po: "PO-501",
    lines: [{ ...LAPTOP, qty: 4 }] },
  { file: "S3-dell-split-part3-over.pdf", vendorId: "V001", number: "INV-DL-2233", date: "15/11/2026", due: "15/12/2026", po: "PO-501",
    lines: [{ ...LAPTOP, qty: 5 }] },
  { file: "N1-dell-resent-new-number.pdf", vendorId: "V001", number: "INV-DL-2231-R", date: "16/11/2026", due: "16/12/2026", po: "PO-501",
    lines: [{ ...LAPTOP, qty: 3 }] },
  { file: "T1-hp-price-within-tolerance.pdf", vendorId: "V002", number: "INV-HP-0940", date: "12/11/2026", due: "12/12/2026", po: "PO-502",
    lines: [{ code: "PRN-M404", desc: "HP LaserJet Pro M404dn printer", qty: 2, price: 22400 }] },
  { file: "P1-dell-no-po-number.pdf", vendorId: "V001", number: "INV-DL-2240", date: "13/11/2026", due: "13/12/2026",
    lines: [{ ...DOCK, qty: 3 }] },
  { file: "P2-dell-wrong-po-number.pdf", vendorId: "V001", number: "INV-DL-2241", date: "13/11/2026", due: "13/12/2026", po: "PO-510",
    lines: [{ ...LAPTOP, qty: 1 }] },
  { file: "X1-hp-quotes-dell-po.pdf", vendorId: "V002", number: "INV-HP-0945", date: "14/11/2026", due: "14/12/2026", po: "PO-501",
    lines: [{ code: "PRN-M404", desc: "HP LaserJet Pro M404dn printer", qty: 1, price: 22000 }] },
  { file: "A1-dell-wrong-total.pdf", vendorId: "V001", number: "INV-DL-2245", date: "14/11/2026", due: "14/12/2026", po: "PO-505",
    lines: [{ ...DOCK, qty: 1 }], totalOverride: 21740 },
  { file: "G1-dell-wrong-tax-type.pdf", vendorId: "V001", number: "INV-DL-2246", date: "14/11/2026", due: "14/12/2026", po: "PO-505",
    lines: [{ ...DOCK, qty: 4 }], taxMode: "IGST" },
  { file: "U1-unknown-vendor.pdf", vendorId: "", number: "SOS/1127", date: "15/11/2026", due: "15/12/2026", po: "PO-509",
    vendor: { name: "Sharma Office Supplies", gstin: sharmaBase + gstinCheckChar(sharmaBase), emailDomain: "sharmaoffice.in" },
    lines: [{ code: "STAT-A4", desc: "A4 copier paper, box of 5 reams", qty: 20, price: 1250 }] },
);

// Third set: date, document type, currency and tax-rate checks.
invoices.push(
  { file: "D1-dell-future-date.pdf", vendorId: "V001", number: "INV-DL-2260", date: "15/01/2027", due: "14/02/2027", po: "PO-505",
    lines: [{ ...DOCK, qty: 1 }] },
  { file: "D2-dell-old-invoice.pdf", vendorId: "V001", number: "INV-DL-1980", date: "10/02/2026", due: "12/03/2026", po: "PO-505",
    lines: [{ ...DOCK, qty: 6 }] },
  { file: "D3-dell-impossible-date.pdf", vendorId: "V001", number: "INV-DL-2262", date: "31/02/2026", due: "31/03/2026", po: "PO-505",
    lines: [{ ...DOCK, qty: 7 }] },
  { file: "C1-dell-credit-note.pdf", vendorId: "V001", number: "CN-DL-0045", date: "16/11/2026", due: "-", po: "PO-501", title: "CREDIT NOTE",
    note: "Against invoice INV-DL-2201 (1 laptop returned, damaged in transit)", lines: [{ ...LAPTOP, qty: 1 }] },
  { file: "K1-hp-proforma.pdf", vendorId: "V002", number: "PI-HP-0077", date: "16/11/2026", due: "Advance", po: "PO-502", title: "PROFORMA INVOICE",
    note: "Advance payment requested before dispatch", lines: [{ code: "PRN-M404", desc: "HP LaserJet Pro M404dn printer", qty: 2, price: 22000 }] },
  { file: "F1-hp-usd-invoice.pdf", vendorId: "V002", number: "INV-HP-0957", date: "16/11/2026", due: "16/12/2026", po: "PO-502", currency: "USD",
    lines: [{ code: "PRN-M404", desc: "HP LaserJet Pro M404dn printer", qty: 1, price: 265 }] },
  { file: "R1-dell-wrong-gst-rate.pdf", vendorId: "V001", number: "INV-DL-2265", date: "17/11/2026", due: "17/12/2026", po: "PO-505", taxRate: 15,
    lines: [{ ...DOCK, qty: 1 }] },
);

for (const inv of invoices) {
  fs.writeFileSync(path.join(OUT, inv.file), await invoicePdf(inv));
}
fs.writeFileSync(path.join(OUT, "E7-payment-reminder.pdf"), await letterPdf());

// I3: real text only in a header and footer; the invoice itself is a JPEG picture inside the PDF.
const picPath = path.join(OUT, "I3-pdf-with-invoice-picture.jpg.tmp");
if (fs.existsSync(picPath)) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const jpg = await doc.embedJpg(fs.readFileSync(picPath));
  page.drawText("Scanned with DocScan app", { x: 40, y: 815, size: 9, font: f, color: rgb(0.4, 0.4, 0.4) });
  page.drawImage(jpg, { x: 40, y: 40, width: 515, height: 765 });
  page.drawText("Page 1 of 1", { x: 270, y: 22, size: 9, font: f, color: rgb(0.4, 0.4, 0.4) });
  fs.writeFileSync(path.join(OUT, "I3-pdf-with-invoice-picture.pdf"), await doc.save());
  fs.unlinkSync(picPath);
}
console.log("samples written to", OUT);
