import { logInbound } from "@/lib/db";
import { checkInbox, gmailConfigured } from "@/lib/gmail";
import { MAX_BYTES } from "@/lib/pipeline";
import { newRunId, runAndStore } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

// Reads unread Gmail messages; every PDF attachment becomes one run.
export async function POST() {
  if (!gmailConfigured()) return Response.json({ configured: false, processed: 0 });
  const results: { subject: string; sender: string; decisions: string[] }[] = [];
  try {
    const { seen, remaining } = await checkInbox(async (m) => {
      const decisions: string[] = [];
      if (m.pdfs.length === 0) {
        await logInbound(m.messageId, m.sender, m.subject, "NO_PDF",
          m.otherAttachments.length ? `No PDF; skipped ${m.otherAttachments.join(", ")}` : "No PDF attachment");
      } else {
        for (const p of m.pdfs) {
          if (p.content.length > MAX_BYTES * 2) { decisions.push("SKIPPED_TOO_LARGE"); continue; }
          const d = await runAndStore({
            id: newRunId(), fileName: p.fileName.slice(0, 200), source: "email", sender: m.sender,
            messageId: m.messageId, attachmentIndex: p.index, pdf: p.content,
          });
          decisions.push(d ?? "ALREADY_PROCESSED");
        }
        await logInbound(m.messageId, m.sender, m.subject, "PROCESSED",
          `${m.pdfs.length} PDF${m.pdfs.length > 1 ? "s" : ""}: ${decisions.join(", ")}` + (m.otherAttachments.length ? `; skipped ${m.otherAttachments.join(", ")}` : ""));
      }
      results.push({ subject: m.subject, sender: m.sender, decisions });
    });
    return Response.json({ configured: true, processed: seen, remaining, results });
  } catch (err) {
    const msg = (err as Error).message;
    const auth = /auth|credential|login/i.test(msg);
    return Response.json({
      configured: true, processed: results.length, results,
      error: auth ? "Gmail rejected the login. Check GMAIL_USER and the App Password." : `Inbox check failed: ${msg.slice(0, 160)}`,
    }, { status: 502 });
  }
}
