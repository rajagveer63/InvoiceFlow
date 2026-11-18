# Image samples for the OCR path: I1 (phone photo, JPG) and I2 (scanned PDF, no text layer). Run: python scripts/make-image-samples.py
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "public" / "samples"
FONT = "C:/Windows/Fonts/arial.ttf"
BOLD = "C:/Windows/Fonts/arialbd.ttf"
BUYER = ("Zamp Demo Buyer Pvt Ltd", "12 MG Road, Bengaluru 560001", "29AABCZ9988K1Z4")

def rs(n): return "Rs. " + f"{n:,.2f}"

def invoice_image(vendor, gstin, domain, number, date, due, po, lines, intra):
    W, H = 1240, 1754  # A4 at 150 dpi
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    f = lambda s, b=False: ImageFont.truetype(BOLD if b else FONT, s)
    y = 90
    d.text((80, y), vendor, font=f(34, True), fill="black"); d.text((880, y), "TAX INVOICE", font=f(30, True), fill="black"); y += 50
    d.text((80, y), f"GSTIN: {gstin}", font=f(22), fill="black"); y += 32
    d.text((80, y), f"billing@{domain}", font=f(22), fill="black"); y += 70
    d.text((80, y), f"Invoice No: {number}", font=f(24, True), fill="black"); d.text((690, y), f"Invoice Date: {date}", font=f(24), fill="black"); y += 38
    d.text((80, y), f"PO Number: {po}", font=f(24), fill="black"); d.text((690, y), f"Due Date: {due}", font=f(24), fill="black"); y += 70
    d.text((80, y), "Bill To:", font=f(22, True), fill="black"); y += 32
    for s in (BUYER[0], BUYER[1], f"GSTIN: {BUYER[2]}"):
        d.text((80, y), s, font=f(22), fill="black"); y += 30
    y += 40
    d.rectangle([70, y - 6, 1170, y + 34], fill=(225, 235, 235))
    for x, s in ((80, "Item Code"), (260, "Description"), (720, "Qty"), (800, "Unit Price"), (1000, "Amount")):
        d.text((x, y), s, font=f(22, True), fill="black")
    y += 52
    sub = 0
    for code, desc, qty, price in lines:
        amt = qty * price; sub += amt
        for x, s in ((80, code), (260, desc), (730, str(qty)), (800, rs(price)), (1000, rs(amt))):
            d.text((x, y), s, font=f(22), fill="black")
        y += 40
    y += 30
    tax = round(sub * 0.18, 2)
    rows = [("Subtotal", sub)] + ([("CGST @ 9%", tax / 2), ("SGST @ 9%", tax / 2)] if intra else [("IGST @ 18%", tax)])
    for label, v in rows:
        d.text((800, y), label, font=f(22), fill="black"); d.text((1000, y), rs(v), font=f(22), fill="black"); y += 36
    d.text((800, y), "Grand Total", font=f(24, True), fill="black"); d.text((1000, y), rs(sub + tax), font=f(24, True), fill="black"); y += 80
    d.text((80, y), "Payment terms: Net 30. Bank: HDFC Bank, A/c 50200012345678, IFSC HDFC0000123", font=f(19), fill="black")
    return img

random.seed(7)
# I1: phone photo of a Dell invoice — slight tilt, warm paper tone, blur, JPEG compression
i1 = invoice_image("Dell India Pvt Ltd", "29AAACD3424M1ZK", "dell.com", "INV-DL-2250", "16/11/2026", "16/12/2026", "PO-505",
                   [("DOCK-WD19", "Dell WD19 docking station", 5, 18000)], intra=True)
paper = Image.new("RGB", (i1.width + 160, i1.height + 160), (196, 186, 170))
paper.paste(i1.rotate(-1.6, expand=False, fillcolor="white", resample=Image.BICUBIC), (80, 80))
tone = Image.new("RGB", paper.size, (255, 244, 225))
photo = Image.blend(paper, tone, 0.12).filter(ImageFilter.GaussianBlur(0.8))
photo.save(OUT / "I1-dell-phone-photo.jpg", "JPEG", quality=72)

# I2: scanned HP invoice saved as a PDF — the PDF holds only a picture, so there is no text layer
i2 = invoice_image("HP India Sales Pvt Ltd", "27AABCH1234Q1ZF", "hp.com", "INV-HP-0950", "17/11/2026", "17/12/2026", "PO-502",
                   [("PRN-M404", "HP LaserJet Pro M404dn printer", 1, 22000)], intra=False)
scan = i2.convert("L").rotate(0.7, fillcolor=255, resample=Image.BICUBIC).filter(ImageFilter.GaussianBlur(0.5))
scan.save(OUT / "I2-hp-scanned.pdf", "PDF", resolution=150)
print("written:", "I1-dell-phone-photo.jpg", "I2-hp-scanned.pdf")

# I3: a PDF with a little real text (scanner-app header and footer) around a picture of the invoice
from PIL import Image as _I
import io
i3 = invoice_image("Dell India Pvt Ltd", "29AAACD3424M1ZK", "dell.com", "INV-DL-2252", "17/11/2026", "17/12/2026", "PO-501",
                   [("LAT-5440", "Dell Latitude 5440 laptop", 1, 75500)], intra=True)
buf = io.BytesIO(); i3.convert("L").filter(ImageFilter.GaussianBlur(0.4)).save(buf, "JPEG", quality=80)
open(OUT / "I3-pdf-with-invoice-picture.jpg.tmp", "wb").write(buf.getvalue())
print("written: I3 picture (wrapped into a PDF by make-samples.ts)")
