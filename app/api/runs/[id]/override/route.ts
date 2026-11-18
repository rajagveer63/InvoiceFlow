import { setOverride } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const decision = body.decision === "APPROVED" || body.decision === "REJECTED" ? body.decision : null;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!decision || reason.length < 5) return Response.json({ code: "BAD_REQUEST", title: "A decision and a reason (5+ characters) are required" }, { status: 400 });
  const ok = await setOverride(id, decision, reason);
  if (!ok) return Response.json({ code: "NOT_OVERRIDABLE", title: "Only a held run without an earlier override can be overridden" }, { status: 409 });
  return Response.json({ ok: true });
}
