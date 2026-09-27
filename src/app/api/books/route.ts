import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listBooks, insertBook } from "@/lib/repo";
import {
  createPresignedUpload,
  verifyUpload,
  saveBookFile,
  tryCompress,
} from "@/lib/storage";

export const runtime = "nodejs";

const EPUB_MIME = "application/epub+zip";
const PDF_MIME = "application/pdf";
const MP4_MIME = "video/mp4";

const VALID_MEDIA_TYPES = ["book", "ln", "manga", "anime_official"] as const;
const MEDIA_BY_EXT: Record<string, string> = {
  epub: "ln", // default EPUBs to Light Novel section; user can retag via Update
  pdf: "book",
  mp4: "anime_official",
  m4v: "anime_official",
  webm: "anime_official",
};

function normalizeMediaType(raw: unknown, fileType: string): string {
  const v = typeof raw === "string" ? raw : "";
  if (VALID_MEDIA_TYPES.includes(v as (typeof VALID_MEDIA_TYPES)[number])) return v;
  return MEDIA_BY_EXT[fileType] || "book";
}

/** GET /api/books — list all books with reading progress */
export async function GET() {
  try {
    const books = await listBooks();
    return NextResponse.json({ success: true, books });
  } catch (error) {
    console.error("List books error:", error);
    return NextResponse.json({ success: false, message: "Failed to load books" }, { status: 500 });
  }
}

/**
 * POST /api/books — upload a book.
 *
 * When B2 is configured, the client does a TWO-STEP upload:
 *   1. POST /api/books?mode=presign { fileType }  → { uploadUrl, uploadId }
 *   2. Browser PUTs the file straight to B2, then
 *      POST /api/books { uploadId, title, ... } confirms and inserts the row.
 * This bypasses serverless request-body limits (~4.5MB) so 200MB books work.
 *
 * Without B2 (local dev), a single multipart POST works as before.
 */

interface PendingUpload {
  bookId: string;
  storageId: string;
  fileType: string;
  createdAt: number;
}

// Short-lived in-memory registry of presigned uploads (per serverless instance).
// The confirm call verifies the object actually exists in B2, so a lost
// registry entry simply fails the confirm — safe.
const pendingUploads = new Map<string, PendingUpload>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function prunePending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, p] of pendingUploads) {
    if (p.createdAt < cutoff) pendingUploads.delete(id);
  }
}

export async function POST(req: NextRequest) {
  try {
    const contentTypeHeader = req.headers.get("content-type") || "";

    // ---------- JSON branch: presign (step 1) OR confirm (step 2) ----------
    if (contentTypeHeader.includes("application/json")) {
      let body: {
        fileType?: string;
        uploadId?: string;
        title?: string;
        author?: string | null;
        tags?: string | null;
        mediaType?: string;
        /** What the browser actually stored: "gzip" (client-side) or "raw". */
        encoding?: string;
        /** Size of the ORIGINAL file before client-side compression. */
        originalSize?: number;
      };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
      }

      // ----- Step 2: confirm a completed presigned upload -----
      if (body.uploadId) {
        const pending = pendingUploads.get(body.uploadId);
        if (!pending) {
          return NextResponse.json(
            { success: false, message: "Unknown or expired uploadId" },
            { status: 400 }
          );
        }
        const title = body.title?.trim();
        if (!title) {
          return NextResponse.json({ success: false, message: "Title is required" }, { status: 400 });
        }

        // verifyUpload returns the STORED size (compressed bytes when the
        // browser uploaded gzip data directly to B2).
        const storedSize = await verifyUpload(pending.storageId);
        if (storedSize === null) {
          return NextResponse.json(
            { success: false, message: "File upload to storage did not complete" },
            { status: 400 }
          );
        }

        pendingUploads.delete(body.uploadId);

        const encoding = body.encoding === "gzip" ? "gzip" : "raw";
        const originalSize = Number(body.originalSize) || (encoding === "gzip" ? 0 : storedSize);

        await insertBook({
          id: pending.bookId,
          title,
          author: body.author?.trim() || null,
          tags: body.tags?.trim() || null,
          storage_provider: "b2",
          storage_id: pending.storageId,
          file_type: pending.fileType,
          // file_size = bytes actually in storage; original_size = pre-compression size
          file_size: storedSize,
          original_size: encoding === "gzip" ? originalSize : null,
          file_encoding: encoding,
          media_type: normalizeMediaType(body.mediaType, pending.fileType),
          uploaded_at: Date.now(),
        });

        return NextResponse.json({
          success: true,
          book: { id: pending.bookId, title, author: body.author ?? null, tags: body.tags ?? null, file_type: pending.fileType, progress: 0 },
        });
      }

      // ----- Step 1: presign -----
      const fileType =
        body.fileType === "epub" || body.fileType === "pdf" || body.fileType === "mp4" ? body.fileType : null;
      if (!fileType) {
        return NextResponse.json(
          { success: false, message: "fileType must be 'epub', 'pdf', or 'mp4'" },
          { status: 400 }
        );
      }

      const bookId = `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const presigned = await createPresignedUpload(
        bookId,
        fileType,
        fileType === "epub" ? EPUB_MIME : fileType === "mp4" ? MP4_MIME : PDF_MIME
      );

      if (!presigned) {
        return NextResponse.json({ success: false, presign: false, message: "Presign unavailable" });
      }

      const uploadId = randomUUID();
      prunePending();
      pendingUploads.set(uploadId, {
        bookId,
        storageId: presigned.storageId,
        fileType,
        createdAt: Date.now(),
      });

      return NextResponse.json({
        success: true,
        presign: true,
        uploadId,
        uploadUrl: presigned.uploadUrl,
        bookId,
      });
    }

    // ---------- Single-step multipart (local dev / non-B2) ----------
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const title = (formData.get("title") as string | null)?.trim();
    const author = (formData.get("author") as string | null)?.trim() || null;
    const tags = (formData.get("tags") as string | null)?.trim() || null;

    // ---------- Classic multipart upload (local disk) ----------
    if (!file) {
      return NextResponse.json({ success: false, message: "No file provided" }, { status: 400 });
    }
    if (!title) {
      return NextResponse.json({ success: false, message: "Title is required" }, { status: 400 });
    }

    const name = file.name.toLowerCase();
    const ext = name.endsWith(".epub") ? "epub" : name.endsWith(".pdf") ? "pdf" : name.endsWith(".mp4") ? "mp4" : name.endsWith(".webm") ? "webm" : null;
    if (!ext) {
      return NextResponse.json(
        { success: false, message: "Only EPUB, PDF, and MP4 files are supported" },
        { status: 400 }
      );
    }

    const rawBuffer = Buffer.from(await file.arrayBuffer());
    if (rawBuffer.byteLength > 200 * 1024 * 1024) {
      return NextResponse.json(
        { success: false, message: "File too large (max 200MB)" },
        { status: 413 }
      );
    }

    const bookId = `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileType = ext;

    // Client may have already gzipped the file (CompressionStream). Otherwise
    // the server applies the same gzip-or-keep-raw policy.
    const declaredEncoding = (formData.get("encoding") as string | null)?.trim();
    const declaredOriginal = Number(formData.get("originalSize")) || 0;
    let payload: Buffer<ArrayBufferLike> = rawBuffer;
    let encoding: "gzip" | "raw" = "raw";
    if (declaredEncoding === "gzip") {
      encoding = "gzip"; // bytes are already compressed
    } else {
      const compressed = tryCompress(rawBuffer);
      payload = compressed.data;
      encoding = compressed.encoding;
    }

    const stored = await saveBookFile(bookId, fileType, payload);

    const mediaType = (formData.get("mediaType") as string | null)?.trim();
    await insertBook({
      id: bookId,
      title,
      author,
      tags,
      storage_provider: stored.provider,
      storage_id: stored.storageId,
      file_type: fileType,
      file_size: payload.byteLength,
      original_size: encoding === "gzip" ? declaredOriginal || rawBuffer.byteLength : null,
      file_encoding: encoding,
      media_type: normalizeMediaType(mediaType, fileType),
      uploaded_at: Date.now(),
    });

    return NextResponse.json({
      success: true,
      book: { id: bookId, title, author, tags, file_type: fileType, progress: 0 },
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ success: false, message: "Upload failed" }, { status: 500 });
  }
}
