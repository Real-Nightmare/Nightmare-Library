import { NextRequest, NextResponse } from "next/server";
import { getBookStorage } from "@/lib/repo";
import { openMediaStream } from "@/lib/storage";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/books/[id]/media — stream video content with HTTP Range support
 * (required for <video> seeking). Serves anime_official MP4/WebM uploads.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const row = await getBookStorage(id);

    if (!row) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    const range = req.headers.get("range");

    // Regular video upload (anime_official)
    const isVideo = ["mp4", "webm", "m4v"].includes(row.file_type);
    if (!isVideo) {
      return NextResponse.json({ success: false, message: "Not a video" }, { status: 400 });
    }

    const opened = await openMediaStream(row.storage_provider, row.storage_id, range);
    if (!opened) {
      return NextResponse.json({ success: false, message: "Video missing" }, { status: 404 });
    }

    const contentType = row.file_type === "webm" ? "video/webm" : "video/mp4";
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "bytes",
    };
    if (opened.size != null) {
      headers["Content-Length"] = String(opened.size);
      if (opened.status === 206) {
        headers["Content-Range"] = `bytes ${opened.start}-${opened.end}/${opened.size}`;
      }
    }
    return new NextResponse(opened.stream as unknown as ReadableStream, {
      status: opened.status,
      headers,
    });
  } catch (error) {
    console.error("Media stream error:", error);
    return NextResponse.json({ success: false, message: "Failed to stream media" }, { status: 500 });
  }
}
