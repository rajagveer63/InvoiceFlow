# InvoiceFlow

An invoice (PDF or photo) goes in. An explained **Approve / Hold / Reject** decision comes out, with every step visible.

**Live demo:** https://invoiceflow-murex-psi.vercel.app

- **The AI reads.** An LLM classifies the document and extracts the invoice fields. Every value is checked against the document text ("✓ found in document" or "location not found").
- **The rules decide.** 19 fixed checks run against the vendor master and the purchase orders. The AI never makes the decision.
- **The AI explains.** A 2-3 sentence plain-English summary is written only from the check results. If the AI is down, a rule-based "Auto summary" is shown instead.

Invoices arrive three ways: a sample button, upload (drag and drop), or **email** to a Gmail inbox that the app checks every 30 seconds.

## Run it locally

```bash
cp .env.example .env.local      # fill in the keys below
npm install
npm run dev                     # open http://localhost:3000
npm run build                   # production build (webpack; Turbopack cannot bundle @libsql)
```

| Variable | Required | Meaning |
|---|---|---|
| `LLM_API_KEY` | yes | Key for any OpenAI-compatible chat API |
| `LLM_BASE_URL` | yes | e.g. `https://inference.hyde.tech/v1` |
| `LLM_MODEL` | yes | e.g. `hyde/glm-5.3-flash` |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | no | Turso database. Without them, a local SQLite file `database/invoice_demo.db` is used |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | no | Gmail inbox to read invoices from (needs a Google **App Password**, not the normal password) |
| `DEMO_TRUSTED_SENDERS` | no | Comma-separated emails trusted to send invoices for any vendor |
| `LLAMA_CLOUD_API_KEY` | no | LlamaParse OCR for photos and scanned PDFs |

`GET /api/health` shows which of these are configured (AI, database, email, OCR). The app sidebar shows the same thing as green dots. Keys live only in `.env.local` (git-ignored) and in the hosting provider's secret settings.

## The app

| Page | What it shows |
|---|---|
| **Overview** | KPI cards (processed, auto-approved %, waiting for review, value held), the runs table, upload box, email inbox with **Testing by email?**, and 28 sample invoices in 4 groups |
| **Run page** (click a run) | Live step tracker, the decision with the AI summary, the original PDF/image, and tabs: **Checks** (filter Failed / Passed / Skipped, expand for expected vs actual), **What the AI read**, **PO** usage bars, **Timing**. A held invoice can be approved or rejected with a written reason |
| **Rules** | Every tolerance and every check, editable in place, plus a "Try it: price check" calculator and the rule history |
| **Database** | Every table live, the change log, and PO balances |

Pages have their own links: `/#rules`, `/#db`, `/#run/<id>`. Press **Esc** on a run to go back. The layout follows the 21st.dev "Dashboard Shell" design, written in plain CSS.

## Email intake

1. On the Overview page, type the address you will send from in **Testing by email?** and click **Add as trusted sender**. This adds it to the `trusted_senders` table; remove it with ×.
2. Email the invoice (PDF, JPG, PNG or WEBP attachment) to the inbox address shown on the page.
3. Within 30 seconds the run appears with "✉ Email" as its source.

The app reads only **unread** emails from the last 2 days that have an invoice attachment, at most 2 per check, and never touches other mail. An email from an address that is not trusted (and not on the vendor's own email domain) is still processed, but **held** by the `sender_domain` check as possible fraud.

## Photos and scans (LlamaParse)

These are read with **LlamaParse**, LlamaIndex's document parser (v2 API, `cost_effective` tier):
- JPG, PNG and WEBP photos of invoices
- scanned PDFs with no text layer
- PDFs where the invoice is a picture and only a header or footer is real text (fewer than 120 characters of text)

The OCR text then goes through the same pipeline. Normal PDFs keep the fast text-layer path and never call LlamaParse. Samples I1 (photo), I2 (scan) and I3 (picture inside a PDF) show the three cases.

## Pipeline

```
Sample / upload / email ─> POST /api/process (streams one event per stage)
  0 File check   PDF or image? under 4 MB? opens? password-protected? ─ no ─> Stopped safely + action for the vendor
                 little or no text ─> LlamaParse OCR
  1 Classify     AI: invoice / credit note / debit note / pro-forma, or a reminder / statement? ─ not invoice ─> Not an invoice
                 (the printed title, e.g. "CREDIT NOTE", overrides the AI)
  2 Extract      AI: strict JSON (number, dates, vendor, GSTIN, PO, currency, lines, CGST/SGST/IGST, total)
  3 Match        vendor by GSTIN (else name), PO by number (else the best-fitting open PO), lines by item code
  4 Validate     19 checks ─> PASS / FAIL / SKIPPED, each with expected vs actual
  5 Decide       any reject-type fail ─> Rejected; any hold-type fail ─> Hold; else Approved
                 then the AI writes the summary from the check rows
```

## The checks (`lib/checks.ts`, in the order they run)

| # | id | Check | On fail |
|---|---|---|---|
| 1 | document_type | Tax invoice, not a credit note, debit note or pro-forma | Hold (separate workflow) |
| 2 | vendor_status | Vendor known and approved | Reject if blocked, else Hold |
| 3 | sender_domain | Emailed from the vendor's domain or a trusted sender (skipped for uploads) | Hold |
| 4 | duplicate_exact | Same file, or same vendor + invoice number, seen before | Reject |
| 5 | duplicate_near | No earlier invoice from this vendor with the same total under another number | Hold |
| 6 | required_fields | Invoice number, date, vendor and total are present | Hold |
| 7 | extraction_confidence | Invoice number, date, GSTIN and total read by the AI appear word-for-word in the document | Hold |
| 8 | invoice_date | A real calendar date, not in the future, not older than the permitted period (180 days) | Hold |
| 9 | gstin_format | GSTIN pattern + check character | Hold |
| 10 | gstin_match | GSTIN equals the vendor record | Hold |
| 11 | tax_type | CGST+SGST within a state, IGST across states | Hold |
| 12 | tax_rate | Tax ÷ taxable amount is a GST slab (0, 0.25, 3, 5, 12, 18, 28, 40%); CGST = SGST | Hold |
| 13 | po_found | PO exists (if not, the best-matching PO is suggested) | Hold |
| 14 | po_belongs | PO was issued to this vendor | Reject |
| 15 | po_open | PO is open | Hold |
| 16 | currency | Invoice currency = PO currency (INR); the price check is skipped if not | Hold |
| 17 | line_price | Unit price within min(2%, ₹5,000) of the PO price | Hold |
| 18 | line_qty | Quantity ≤ what is left on the PO line (tracks one PO split across invoices) | Hold |
| 19 | arithmetic | Lines = subtotal; subtotal + tax = total (±₹1) | Hold |

A check is **SKIPPED** rather than passed when its input is missing (for example, no PO was found, or the invoice was uploaded rather than emailed).

## Editable rules

On the **Rules** page you can change, directly:
- the tolerances: price %, price cap, quantity %, rounding, near-duplicate amount, and the oldest invoice date accepted (default 180 days), with a slider or an exact number
- each check: **Default**, always **Hold**, always **Reject**, or **Off**

Changed items are outlined. A bar appears at the bottom with the number of changes; saving needs a reason and creates a new version in `rule_versions` (versions are never edited in place). Every run records the rule-set version that decided it. The history shows what changed in each version. **Restore defaults** saves the defaults as a new version. The check logic itself stays in code.

## Database

SQLite: Turso when `DATABASE_URL` is set, otherwise the local file `database/invoice_demo.db`.

| Table | Holds |
|---|---|
| `vendors`, `purchase_orders`, `po_lines` | Master data (seeded from `lib/data.ts`) |
| `trusted_senders` | Email senders trusted to send invoices |
| `rule_versions` | Every saved version of the rules |
| `runs` | One row per invoice: events, decision, override, the original file |
| `inbound_messages` | Emails read from the Gmail inbox |
| `db_changes` | Log of every write the app makes |

**Reset demo** deletes runs and inbound emails. It keeps the change log, the rules and the trusted senders.

## Demo scenarios (`public/samples`, regenerate with `node scripts/make-samples.ts`)

| Sample | What happens |
|---|---|
| H Dell laptops, PO-501 | **Approved**: every check passes |
| E1 Dell monitors, PO-504 | **Hold**: bills 2, only 1 left on the PO (usage bar passes 100%) |
| E4 HP printers, PO-502 | **Hold**: unit price 5% above PO, tolerance 2% |
| E6 Dell docks, PO-505 | **Hold**: one GSTIN character changed, which fails both the check character and the vendor match |
| E8 Acme Traders | **Rejected**: vendor is blocked |
| E5 Password-protected PDF | **Stopped safely**: nothing extracted; "ask the vendor for an unlocked copy" |
| E7 Payment reminder | **Not an invoice**: no decision needed |
| H again | **Rejected**: duplicate (same file) |
| S1 → S2 → S3 (PO-501, 10 laptops) | **Split PO**: S1 (3) and S2 (4) are **Approved**. S3 (5 more) is **Held**, because the parts together exceed the PO |
| N1 | **Hold**: S1 re-sent under a new invoice number (same vendor + same total) |
| T1 | **Approved**: price +1.8%, inside the 2% tolerance |
| P1 / P2 | **Hold**: PO number missing or mistyped; the app suggests the best-matching PO |
| X1 | **Rejected**: HP invoice quoting Dell's PO |
| A1 | **Hold**: the total is ₹500 off |
| G1 | **Hold**: same-state vendor charged IGST |
| U1 | **Hold**: unknown vendor |
| D1 / D2 / D3 | **Hold**: invoice date in the future / older than 180 days / 31 February (not a real date) |
| C1 | **Hold**: a credit note, sent to the credit-note workflow instead of being paid |
| K1 | **Hold**: a pro-forma invoice, not a final tax invoice |
| F1 | **Hold**: invoice in USD, PO in INR |
| R1 | **Hold**: GST charged at 15%, which is not a GST rate (the totals still add up, so only this check catches it) |
| I1 / I2 / I3 | **Approved**: a phone photo, a scanned PDF and a PDF holding a picture, all read with LlamaParse OCR |

All 28 files are in `public/samples/all-test-invoices.zip` (also linked on the Overview page), ready to email in. Run the samples after **Reset demo**; S1 → S2 → S3 must run in that order.

## Interview demo script (about 5 minutes)

1. **Reset demo.** Explain the sidebar (system status) and the KPI cards.
2. **H.** Walk through the live step tracker, the AI summary, the Checks tab and "What the AI read". Say: "The AI reads; the rules decide."
3. **E1.** Open the PO tab: the usage bar goes past 100%.
4. **S1 → S2 → S3.** One PO split across three invoices; the third is held.
5. **E6.** A single changed GSTIN digit is caught by the check character.
6. **R1, C1, F1.** Wrong GST rate, a credit note, a USD invoice: each held with a plain reason.
7. **H again.** Caught as a duplicate.
8. **E5 and E7.** Safe stop, and "not an invoice". Neither is guessed into a decision.
9. **E4.** Click **Approve anyway** with a reason. The override is recorded and the system decision stays visible.
10. **Rules.** Drag the price tolerance to 6% in "Try it", discard, and show the history. Optionally: have the interviewer add their email and send an invoice.

## What a production version would add (not built)

- Login, roles, and a second approver for rule changes and overrides.
- GRN (goods received) 3-way match.
- An ERP connector (Tally / SAP / Zoho) for live vendors and POs.
- TDS and e-invoice IRN / QR checks.
- Per-line GST rates (today a mixed-rate invoice is held for a person to check).
- A queue-based runner and push-based email (instead of polling) for volume.

## Assumptions

- Buyer is in Karnataka (GST state 29); POs are in INR.
- Master data (vendors, POs) is seeded from `lib/data.ts` into the database.
- Dates are read day-first (05/11/2026 = 5 November 2026), in India time.
- Files up to 4 MB.
- The demo is public: anyone with the link can run samples, add a trusted sender (max 25) or change the rules (always with a reason, always versioned).
