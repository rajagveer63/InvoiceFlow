import { dbDump } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await dbDump());
  } catch (err) {
    return Response.json({ code: "DB_ERROR", title: "Could not read the database", detail: (err as Error).message.slice(0, 200) }, { status: 500 });
  }
}
