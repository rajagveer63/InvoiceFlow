import { dbKind } from "@/lib/db";
import { gmailConfigured } from "@/lib/gmail";
import { llamaParseConfigured } from "@/lib/llamaparse";
import { llmConfigured } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ok: llmConfigured(),
    llm: llmConfigured() ? "configured" : "missing LLM_API_KEY / LLM_BASE_URL / LLM_MODEL",
    database: dbKind(),
    ocr: llamaParseConfigured(),
    email: gmailConfigured() ? { configured: true, address: process.env.GMAIL_USER } : { configured: false },
  });
}
