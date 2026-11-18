import { getPdf } from "@/lib/db";
import { sniffType } from "@/lib/llamaparse";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pdf = await getPdf(id);
  if (!pdf) return new Response("Not found", { status: 404 });
  const { mime } = sniffType(pdf);
  return new Response(new Blob([pdf as BlobPart], { type: mime }), {
    headers: { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600" },
  });
}
