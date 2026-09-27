import { NextRequest, NextResponse } from "next/server";
import { saveProgress, getProgress, markBookRead } from "@/lib/repo";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** POST /api/books/[id]/progress — save reading progress { percent, page, chapter } */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;

    let body: { percent?: number; page?: number; chapter?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
    }

    const percent = Math.max(0, Math.min(100, Math.round(Number(body.percent ?? 0))));
    const page = body.page != null ? Math.max(1, Math.round(Number(body.page))) : null;
    const chapter = body.chapter ?? null;
    const now = Date.now();

    await saveProgress(id, percent, page, chapter, now);
    await markBookRead(id, now);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Save progress error:", error);
    return NextResponse.json({ success: false, message: "Failed to save progress" }, { status: 500 });
  }
}

/** GET /api/books/[id]/progress — fetch saved progress */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const progress = await getProgress(id);
    return NextResponse.json({ success: true, progress });
  } catch (error) {
    console.error("Get progress error:", error);
    return NextResponse.json({ success: false, message: "Failed to load progress" }, { status: 500 });
  }
}
