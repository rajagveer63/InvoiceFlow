import { listInbound, listRuns } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [runs, inbox] = await Promise.all([listRuns(), listInbound()]);
    return Response.json({ runs, inbox });
  } catch (err) {
    return Response.json({ code: "DB_ERROR", title: "Could not read the database", detail: (err as Error).message.slice(0, 200) }, { status: 500 });
  }
}
