import { addSender, listSenders, removeSender } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const clean = (v: unknown) => String(v ?? "").trim().toLowerCase();
const problem = (status: number, title: string) => Response.json({ title }, { status });

export async function GET() {
  return Response.json({ senders: await listSenders(), inboxTrusted: (process.env.DEMO_TRUSTED_SENDERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = clean(body.email);
  if (email.length > 254 || !EMAIL.test(email)) return problem(400, "Enter a valid email address, like name@company.com");
  const r = await addSender(email, "Added from the dashboard for testing");
  if (r === "full") return problem(409, "The list is full (25 addresses). Remove one first.");
  return Response.json({ ok: true, status: r, senders: await listSenders() });
}

export async function DELETE(req: Request) {
  const email = clean(new URL(req.url).searchParams.get("email"));
  if (!email) return problem(400, "Which email should be removed?");
  await removeSender(email);
  return Response.json({ ok: true, senders: await listSenders() });
}
