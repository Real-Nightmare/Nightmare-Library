import { NextRequest, NextResponse } from "next/server";
import { getBookStorage } from "@/lib/repo";
import { readBookFileDecoded } from "@/lib/storage";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/books/[id]/file — the book file for the reader, FULLY DECODED.
 * Gzip-compressed uploads are decompressed here transparently, so the
 * browser always receives the original EPUB/PDF bytes. Video never takes
 * this path (it streams via /media).
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const row = await getBookStorage(id);

    if (!row) {
      return NextResponse.json({ success: false, message: "Book not found" }, { status: 404 });
    }

    const data = await readBookFileDecoded(
      (row as { storage_provider: string }).storage_provider,
      row.storage_id,
      (row as { file_encoding?: string }).file_encoding
    );
    if (!data) {
      return NextResponse.json({ success: false, message: "Book file missing" }, { status: 404 });
    }

    const isEpub = row.file_type === "epub";
    const filename = `${(row.title as string).replace(/[^a-z0-9]+/gi, "_")}.${row.file_type}`;

    const headers: Record<string, string> = {
      "Content-Type": isEpub ? "application/epub+zip" : "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "none",
      "Content-Length": String(data.byteLength),
    };

    return new NextResponse(new Uint8Array(data), { headers });
  } catch (error) {
    console.error("Book file error:", error);
    return NextResponse.json({ success: false, message: "Failed to load file" }, { status: 500 });
  }
}
