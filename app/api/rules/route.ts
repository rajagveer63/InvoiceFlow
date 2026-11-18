import { REGISTRY } from "@/lib/checks";
import { loadRules, ruleHistory, saveRules } from "@/lib/db";
import { validateRules } from "@/lib/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [current, history] = await Promise.all([loadRules(), ruleHistory()]);
    return Response.json({ current, history });
  } catch (err) {
    return Response.json({ code: "DB_ERROR", title: "Could not read the rules", detail: (err as Error).message.slice(0, 200) }, { status: 500 });
  }
}

// Saves a new rule version. Body: { rules: RuleSettings, reason: string }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  if (reason.length < 5) return Response.json({ code: "BAD_REQUEST", title: "Say why you are changing the rules (5+ characters)" }, { status: 400 });
  const v = validateRules(body.rules, REGISTRY.map((r) => r.id));
  if (!v.ok) return Response.json({ code: "BAD_REQUEST", title: v.error }, { status: 400 });
  try {
    return Response.json({ current: await saveRules(v.rules, reason) });
  } catch (err) {
    return Response.json({ code: "DB_ERROR", title: "Could not save the rules", detail: (err as Error).message.slice(0, 200) }, { status: 500 });
  }
}
