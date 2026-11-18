// Master data for the demo (normally from the ERP). No imports: also read by scripts/make-samples.ts.

export type VendorStatus = "APPROVED" | "BLOCKED" | "PENDING";

export interface Vendor {
  id: string;
  name: string;
  gstin: string;
  state: string; // GST state code (first 2 GSTIN digits)
  status: VendorStatus;
  emailDomain: string;
}

export interface POLine {
  itemCode: string;
  description: string;
  qty: number;
  unitPrice: number;
}

export interface PurchaseOrder {
  number: string;
  vendorId: string;
  status: "OPEN" | "CLOSED";
  currency: "INR";
  lines: POLine[];
}

export const BUYER = {
  name: "Zamp Demo Buyer Pvt Ltd",
  gstin: "29AABCZ9988K1Z4",
  state: "29",
  address: "12 MG Road, Bengaluru, Karnataka 560001",
};

export const VENDORS: Vendor[] = [
  { id: "V001", name: "Dell India Pvt Ltd", gstin: "29AAACD3424M1ZK", state: "29", status: "APPROVED", emailDomain: "dell.com" },
  { id: "V002", name: "HP India Sales Pvt Ltd", gstin: "27AABCH1234Q1ZF", state: "27", status: "APPROVED", emailDomain: "hp.com" },
  { id: "V003", name: "Acme Traders", gstin: "07AAKFA5678R1ZJ", state: "07", status: "BLOCKED", emailDomain: "acmetraders.in" },
];

export const PURCHASE_ORDERS: PurchaseOrder[] = [
  { number: "PO-501", vendorId: "V001", status: "OPEN", currency: "INR", lines: [{ itemCode: "LAT-5440", description: "Dell Latitude 5440 laptop", qty: 10, unitPrice: 75000 }] },
  { number: "PO-504", vendorId: "V001", status: "OPEN", currency: "INR", lines: [{ itemCode: "MON-P2423", description: "Dell P2423 24-inch monitor", qty: 5, unitPrice: 15000 }] },
  { number: "PO-505", vendorId: "V001", status: "OPEN", currency: "INR", lines: [{ itemCode: "DOCK-WD19", description: "Dell WD19 docking station", qty: 10, unitPrice: 18000 }] },
  { number: "PO-502", vendorId: "V002", status: "OPEN", currency: "INR", lines: [{ itemCode: "PRN-M404", description: "HP LaserJet Pro M404dn printer", qty: 6, unitPrice: 22000 }] },
  { number: "PO-508", vendorId: "V003", status: "OPEN", currency: "INR", lines: [{ itemCode: "CHR-ERG", description: "Ergonomic office chair", qty: 20, unitPrice: 9000 }] },
];

// Invoices already approved before the demo (draw down PO-504 to 1 remaining monitor).
export const SEED_APPROVED = [
  { invoiceNumber: "INV-2026-103", vendorId: "V001", poNumber: "PO-504", itemCode: "MON-P2423", qty: 2 },
  { invoiceNumber: "INV-2026-104", vendorId: "V001", poNumber: "PO-504", itemCode: "MON-P2423", qty: 2 },
];

// Tolerances (rule set v1).
export const RULES = {
  version: 1,
  linePricePct: 0.02,
  linePriceCapInr: 5000,
  arithmeticToleranceInr: 1,
};

export interface Sample {
  id: string;
  file: string;
  title: string;
  expected: string;
  shows: string;
}

export const SAMPLES: Sample[] = [
  { id: "H", file: "H-dell-clean.pdf", title: "Dell laptops, PO-501", expected: "Approved", shows: "Happy path: every check passes" },
  { id: "E1", file: "E1-dell-po-overrun.pdf", title: "Dell monitors, PO-504", expected: "Hold", shows: "Asks for 2 monitors, only 1 left on the PO" },
  { id: "E4", file: "E4-hp-price-over.pdf", title: "HP printers, PO-502", expected: "Hold", shows: "Unit price 5% above the PO price" },
  { id: "E6", file: "E6-dell-wrong-gstin.pdf", title: "Dell docks, PO-505", expected: "Hold", shows: "One GSTIN character changed" },
  { id: "E8", file: "E8-blocked-vendor.pdf", title: "Acme Traders chairs", expected: "Reject", shows: "Vendor is blocked" },
  { id: "E5", file: "E5-dell-locked.pdf", title: "Password-protected PDF", expected: "Stopped safely", shows: "Cannot be opened, nothing extracted" },
  { id: "E7", file: "E7-payment-reminder.pdf", title: "Payment reminder letter", expected: "Not an invoice", shows: "AI recognises it is not an invoice" },
  { id: "S1", file: "S1-dell-split-part1.pdf", title: "Split PO-501, part 1 of 3", expected: "Approved", shows: "3 of 10 laptops billed" },
  { id: "S2", file: "S2-dell-split-part2.pdf", title: "Split PO-501, part 2 of 3", expected: "Approved", shows: "4 more laptops; still within the PO" },
  { id: "S3", file: "S3-dell-split-part3-over.pdf", title: "Split PO-501, part 3 of 3", expected: "Hold", shows: "5 more laptops; together the parts exceed the PO" },
  { id: "N1", file: "N1-dell-resent-new-number.pdf", title: "S1 re-sent with a new number", expected: "Hold", shows: "Same vendor and total as S1: possible duplicate" },
  { id: "T1", file: "T1-hp-price-within-tolerance.pdf", title: "HP printers, price +1.8%", expected: "Approved", shows: "Close but not exact: inside the 2% tolerance" },
  { id: "P1", file: "P1-dell-no-po-number.pdf", title: "Dell docks, no PO number", expected: "Hold", shows: "App finds the best-matching PO (PO-505)" },
  { id: "P2", file: "P2-dell-wrong-po-number.pdf", title: "Dell laptop, PO typo PO-510", expected: "Hold", shows: "PO does not exist; app suggests PO-501" },
  { id: "X1", file: "X1-hp-quotes-dell-po.pdf", title: "HP invoice quoting Dell's PO", expected: "Reject", shows: "PO-501 belongs to another vendor" },
  { id: "A1", file: "A1-dell-wrong-total.pdf", title: "Dell dock, total off by Rs 500", expected: "Hold", shows: "Subtotal + tax does not equal the total" },
  { id: "G1", file: "G1-dell-wrong-tax-type.pdf", title: "Dell docks, IGST charged", expected: "Hold", shows: "Same-state vendor must charge CGST + SGST" },
  { id: "U1", file: "U1-unknown-vendor.pdf", title: "Sharma Office Supplies", expected: "Hold", shows: "Vendor is not in the vendor master" },
  { id: "D1", file: "D1-dell-future-date.pdf", title: "Dell dock, dated Jan 2027", expected: "Hold", shows: "Invoice date is in the future" },
  { id: "D2", file: "D2-dell-old-invoice.pdf", title: "Dell docks, dated Feb 2026", expected: "Hold", shows: "Older than the 180-day permitted period" },
  { id: "D3", file: "D3-dell-impossible-date.pdf", title: "Dell docks, dated 31/02/2026", expected: "Hold", shows: "31 February is not a real date" },
  { id: "C1", file: "C1-dell-credit-note.pdf", title: "Dell credit note", expected: "Hold", shows: "Credit note goes to its own workflow, not paid" },
  { id: "K1", file: "K1-hp-proforma.pdf", title: "HP pro-forma, 2 printers", expected: "Hold", shows: "Pro-forma is not a final tax invoice" },
  { id: "F1", file: "F1-hp-usd-invoice.pdf", title: "HP printer billed in USD", expected: "Hold", shows: "Invoice in USD, PO in INR" },
  { id: "R1", file: "R1-dell-wrong-gst-rate.pdf", title: "Dell dock, GST at 15%", expected: "Hold", shows: "15% is not a GST rate (totals still add up)" },
  { id: "I1", file: "I1-dell-phone-photo.jpg", title: "Phone photo (JPG) of a Dell invoice", expected: "Approved", shows: "Read with LlamaParse OCR, then the same checks" },
  { id: "I2", file: "I2-hp-scanned.pdf", title: "Scanned HP invoice (PDF, no text)", expected: "Approved", shows: "No text layer: LlamaParse OCR reads the scan" },
  { id: "I3", file: "I3-pdf-with-invoice-picture.pdf", title: "PDF with a picture of the invoice", expected: "Approved", shows: "Only a footer is real text; OCR reads the picture" },
];
