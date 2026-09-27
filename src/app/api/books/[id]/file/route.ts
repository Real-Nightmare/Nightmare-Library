import { NextRequest, NextResponse } from "next/server";
import { getBookStorage } from "@/lib/repo";
import { openBookStream } from "@/lib/storage";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/books/[id]/file — stream the book file for the reader.
 * B2 files stream straight from object storage (no full-file buffering),
 * keeping memory flat for 100MB+ books on serverless.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const row = await getBookStorage(id);

    if (!row) {
      return NextResponse.json({ success: false, message: "Book not found" }, { status: 404 });
    }

    const opened = await openBookStream(row.storage_provider, row.storage_id);
    if (!opened) {
      return NextResponse.json({ success: false, message: "Book file missing" }, { status: 404 });
    }

    const isEpub = row.file_type === "epub";
    const filename = `${(row.title as string).replace(/[^a-z0-9]+/gi, "_")}.${row.file_type}`;

    const headers: Record<string, string> = {
      "Content-Type": isEpub ? "application/epub+zip" : "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "none",
    };
    if (opened.size != null) headers["Content-Length"] = String(opened.size);

    return new NextResponse(opened.stream as unknown as ReadableStream, { headers });
  } catch (error) {
    console.error("Book file error:", error);
    return NextResponse.json({ success: false, message: "Failed to load file" }, { status: 500 });
  }
}
