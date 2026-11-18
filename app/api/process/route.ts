import { SAMPLES } from "@/lib/data";
import { newRunId, runAndStore } from "@/lib/store";
import type { StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ code: "BAD_REQUEST", title: "Send the PDF as multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ code: "NO_FILE", title: "No file was attached" }, { status: 400 });
  const sample = String(form.get("sampleFile") ?? "");
  const sampleFile = SAMPLES.some((s) => s.file === sample) ? sample : undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (e: StreamEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await runAndStore({ id: newRunId(), fileName: file.name.slice(0, 200), sampleFile, source: "upload", pdf: bytes }, emit);
      } catch (err) {
        emit({ type: "decision", decision: "ERROR", headline: "System error: could not save the run", action: "Check the database settings." });
        emit({ type: "error", message: (err as Error).message.slice(0, 200) });
        emit({ type: "done", totalMs: 0 });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
