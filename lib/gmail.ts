// Reads new invoice emails from a Gmail inbox over IMAP (GMAIL_USER + GMAIL_APP_PASSWORD).
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export function gmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

export interface InboundEmail {
  messageId: string;
  sender: string;
  subject: string;
  pdfs: { fileName: string; content: Uint8Array; index: number }[];
  otherAttachments: string[];
}

/**
 * Opens the inbox, hands each unread email to `handle`, then marks it read.
 * An email whose handler throws stays unread, so the next check retries it.
 */
export async function checkInbox(handle: (m: InboundEmail) => Promise<void>, maxEmails = 2): Promise<{ seen: number; remaining: number }> {
  if (!gmailConfigured()) throw new Error("Email is not configured (set GMAIL_USER and GMAIL_APP_PASSWORD)");
  const imap = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER!, pass: process.env.GMAIL_APP_PASSWORD!.replace(/\s+/g, "") },
    logger: false,
  });
  await imap.connect();
  const lock = await imap.getMailboxLock("INBOX");
  let seen = 0;
  let remaining = 0;
  try {
    // Only recent unread mail that carries a PDF or an invoice photo: the rest of the inbox is never opened or marked read.
    const query = process.env.GMAIL_QUERY || "is:unread has:attachment {filename:pdf filename:jpg filename:jpeg filename:png filename:webp} newer_than:2d";
    const uids = ((await imap.search({ gmailraw: query }, { uid: true })) || []) as number[];
    remaining = Math.max(0, uids.length - maxEmails);
    for (const uid of uids.slice(0, maxEmails)) {
      const msg = await imap.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const pdfs: InboundEmail["pdfs"] = [];
      const others: string[] = [];
      (parsed.attachments ?? []).forEach((a, i) => {
        const name = a.filename ?? `attachment-${i + 1}`;
        if (/^(application\/pdf|image\/(jpeg|png|webp))$/.test(a.contentType) || /\.(pdf|jpe?g|png|webp)$/i.test(name)) pdfs.push({ fileName: name, content: new Uint8Array(a.content), index: i });
        else others.push(name);
      });
      const fromAddr = parsed.from?.value?.[0]?.address ?? "unknown";
      await handle({
        messageId: parsed.messageId ?? `uid-${uid}-${parsed.date?.getTime() ?? 0}`,
        sender: fromAddr.toLowerCase(),
        subject: parsed.subject ?? "(no subject)",
        pdfs,
        otherAttachments: others,
      });
      await imap.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      seen++;
    }
  } finally {
    lock.release();
    await imap.logout().catch(() => {});
  }
  return { seen, remaining };
}
