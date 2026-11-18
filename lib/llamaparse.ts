// OCR for photos and scanned PDFs via LlamaParse (LlamaIndex's document parser, REST API).
// Set LLAMA_CLOUD_API_KEY. Normal PDFs with a text layer never come here.

const BASE = (process.env.LLAMA_CLOUD_BASE_URL || "https://api.cloud.llamaindex.ai").replace(/\/$/, "") + "/api/v2/parse";
const TIER = process.env.LLAMA_PARSE_TIER || "cost_effective"; // AI OCR tier; "fast" does not read images
const POLL_MS = 1500;
const TIMEOUT_MS = 40_000; // leaves room for the AI steps inside the 60 s function limit

export function llamaParseConfigured(): boolean {
  return Boolean(process.env.LLAMA_CLOUD_API_KEY);
}

const auth = () => ({ Authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}` });

/** LlamaParse returns tables as HTML inside Markdown; flatten them so the AI and the provenance check read plain rows. */
function flatten(md: string): string {
  return md
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+\n/g, "\n");
}

/** Uploads one file to LlamaParse (v2 API), waits for the job, and returns the text it read. */
export async function parseWithLlamaParse(bytes: Uint8Array, fileName: string, mime: string): Promise<string> {
  if (!llamaParseConfigured()) throw new Error("LlamaParse is not configured (set LLAMA_CLOUD_API_KEY)");
  const fd = new FormData();
  fd.append("configuration", JSON.stringify({ tier: TIER, version: "latest", client_name: "invoiceflow" }));
  fd.append("file", new Blob([bytes as BlobPart], { type: mime }), fileName);
  const up = await fetch(`${BASE}/upload`, { method: "POST", headers: auth(), body: fd, signal: AbortSignal.timeout(20_000) });
  if (!up.ok) throw new Error(`LlamaParse upload failed (${up.status}): ${(await up.text()).slice(0, 160)}`);
  const { id } = (await up.json()) as { id: string };

  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const st = await fetch(`${BASE}/${id}`, { headers: auth(), signal: AbortSignal.timeout(10_000) });
    if (!st.ok) throw new Error(`LlamaParse status check failed (${st.status})`);
    const { job } = (await st.json()) as { job: { status: string; error_message?: string } };
    if (job.status === "COMPLETED") break;
    if (job.status === "FAILED" || job.status === "CANCELLED") throw new Error(`LlamaParse could not read the file (${job.error_message ?? job.status})`);
    if (Date.now() > deadline) throw new Error("LlamaParse took longer than 40 s");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const res = await fetch(`${BASE}/${id}?expand=markdown_full`, { headers: auth(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`LlamaParse result failed (${res.status})`);
  const { markdown_full } = (await res.json()) as { markdown_full?: string | null };
  return flatten(markdown_full ?? "");
}

/** Detects the file type from its first bytes (never trusts the file name). */
export function sniffType(bytes: Uint8Array): { kind: "pdf" | "image" | "other"; mime: string } {
  const b = bytes;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return { kind: "pdf", mime: "application/pdf" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: "image", mime: "image/png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return { kind: "image", mime: "image/webp" };
  return { kind: "other", mime: "application/octet-stream" };
}
