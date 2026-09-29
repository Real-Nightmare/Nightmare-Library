import { NextRequest, NextResponse } from "next/server";
import { readCover, detectImageType } from "@/lib/cover";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/books/[id]/cover — extracted cover image (EPUB uploads only).
 * 404 when no cover exists; the UI falls back to the file-type placeholder.
 * Content type is sniffed from magic bytes (EPUB manifests often lie).
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const data = await readCover(id);
    if (!data) {
      return NextResponse.json({ success: false, message: "No cover" }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": detectImageType(data),
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (error) {
    console.error("Cover error:", error);
    return NextResponse.json({ success: false, message: "Failed to load cover" }, { status: 500 });
  }
}
