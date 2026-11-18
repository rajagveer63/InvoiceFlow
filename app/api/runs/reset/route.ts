import { resetAll } from "@/lib/db";

export const runtime = "nodejs";

export async function POST() {
  await resetAll();
  return Response.json({ ok: true });
}
