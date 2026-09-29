import { NextRequest, NextResponse } from "next/server";
import { updateBook } from "@/lib/repo";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const VALID_MEDIA_TYPES = ["book", "ln", "manga", "anime_official"];

/** PATCH /api/books/[id] — update metadata / favorite */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;

    let body: { title?: string; author?: string; tags?: string; is_favorite?: boolean; media_type?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
    }

    const fields: { title?: string; author?: string; tags?: string; is_favorite?: boolean; media_type?: string } = {};
    if (body.title !== undefined) {
      const t = String(body.title).trim().slice(0, 300);
      if (!t) return NextResponse.json({ success: false, message: "Title cannot be empty" }, { status: 400 });
      fields.title = t;
    }
    if (body.author !== undefined) fields.author = String(body.author).trim().slice(0, 200) || undefined;
    if (body.tags !== undefined) fields.tags = String(body.tags).trim().slice(0, 500) || undefined;
    if (body.is_favorite !== undefined) fields.is_favorite = Boolean(body.is_favorite);
    if (body.media_type !== undefined) {
      if (!VALID_MEDIA_TYPES.includes(body.media_type)) {
        return NextResponse.json({ success: false, message: "Invalid media_type" }, { status: 400 });
      }
      fields.media_type = body.media_type;
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ success: false, message: "Nothing to update" }, { status: 400 });
    }

    await updateBook(id, fields);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Update book error:", error);
    return NextResponse.json({ success: false, message: "Update failed" }, { status: 500 });
  }
}
