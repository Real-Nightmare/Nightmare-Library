import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listBooks, insertBook, insertContentChapter } from "@/lib/repo";
import {
  createPresignedUpload,
  verifyUpload,
  saveBookFile,
  tryCompress,
  tryDecompress,
} from "@/lib/storage";
import { extractCover, saveCover } from "@/lib/cover";
import { extractEpubMeta, looksLikeFilenameTitle } from "@/lib/epubmeta";
import { indexEpubContent } from "@/lib/indexer";

export const runtime = "nodejs";

const EPUB_MIME = "application/epub+zip";
const PDF_MIME = "application/pdf";
const MP4_MIME = "video/mp4";
const VIDEO_MIME: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", m4v: "video/mp4" };

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
// registry entry simply fails the confirm — safe. prunePending() caps the
// map so abandoned uploads can't grow it forever.
const pendingUploads = new Map<string, PendingUpload>();
const PENDING_TTL_MS = 15 * 60 * 1000;
const PENDING_MAX = 200;

function prunePending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, p] of pendingUploads) {
    if (p.createdAt < cutoff) pendingUploads.delete(id);
  }
  // Hard cap (oldest first) — defense against unbounded growth.
  while (pendingUploads.size > PENDING_MAX) {
    const oldest = pendingUploads.keys().next().value;
    if (!oldest) break;
    pendingUploads.delete(oldest);
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
        /** Stateless-confirm fields: the client echoes back what presign returned, */
        /** so the server does not depend on in-memory state surviving between requests. */
        bookId?: string;
        storageId?: string;
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
      if (body.uploadId || (body.bookId && body.storageId)) {
        // Stateless first: trust the client-echoed presign facts, then VERIFY
        // against storage (storedSize === null when the object isn't there).
        // The legacy in-memory registry is only a fallback for stale clients.
        const pending =
          body.bookId && body.storageId
            ? {
                bookId: body.bookId,
                storageId: body.storageId,
                fileType:
                  body.fileType === "epub" || body.fileType === "pdf" || body.fileType === "mp4" || body.fileType === "webm" || body.fileType === "m4v"
                    ? body.fileType
                    : "epub",
                createdAt: Date.now(),
              }
            : pendingUploads.get(body.uploadId ?? "");
        if (!pending) {
          return NextResponse.json(
            { success: false, message: "Unknown or expired uploadId" },
            { status: 400 }
          );
        }
        if (body.uploadId) pendingUploads.delete(body.uploadId);
        const title = body.title?.trim();
        if (!title) {
          return NextResponse.json({ success: false, message: "Title is required" }, { status: 400 });
        }

        // verifyUpload returns the STORED size (compressed bytes when the
        // browser uploaded gzip data directly to B2). This doubles as proof
        // that the echoed bookId/storageId pair is genuine.
        const storedSize = await verifyUpload(pending.storageId);
        if (storedSize === null) {
          return NextResponse.json(
            { success: false, message: "File upload to storage did not complete" },
            { status: 400 }
          );
        }

        const encoding = body.encoding === "gzip" ? "gzip" : "raw";
        const originalSize = Number(body.originalSize) || (encoding === "gzip" ? 0 : storedSize);

        // Cover extraction (EPUB only, best-effort): pull the original bytes
        // back from storage and grab the manifest-declared cover image.
        let coverUrl: string | null = null;
        let epubOriginal: Buffer | null = null;
        if (pending.fileType === "epub") {
          const { readBookFileDecoded } = await import("@/lib/storage");
          epubOriginal = await readBookFileDecoded("b2", pending.storageId, encoding);
          if (epubOriginal) {
            const cover = await extractCover("epub", epubOriginal);
            if (cover) {
              await saveCover(pending.bookId, cover);
              coverUrl = `/api/books/${pending.bookId}/cover`;
            }
          }
        }

        // The browser only knows the filename, so uploads used to land as
        // "vol3" / "Unknown hand". The EPUB itself carries the real title and
        // author in its OPF package document — trust the file over the
        // filename, but never overwrite a title someone deliberately set.
        let finalTitle = title;
        let finalAuthor = body.author?.trim() || null;
        if (epubOriginal) {
          const meta = await extractEpubMeta(epubOriginal);
          if (meta) {
            if (meta.title && looksLikeFilenameTitle(title)) finalTitle = meta.title;
            if (meta.author && !finalAuthor) finalAuthor = meta.author;
          }
        }

        await insertBook({
          id: pending.bookId,
          title: finalTitle,
          author: finalAuthor,
          tags: body.tags?.trim() || null,
          storage_provider: "b2",
          storage_id: pending.storageId,
          file_type: pending.fileType,
          // file_size = bytes actually in storage; original_size = pre-compression size
          file_size: storedSize,
          original_size: encoding === "gzip" ? originalSize : null,
          file_encoding: encoding,
          media_type: normalizeMediaType(body.mediaType, pending.fileType),
          cover_url: coverUrl,
          uploaded_at: Date.now(),
        });

        // Content indexing AFTER the book row exists (FK requires it).
        if (epubOriginal) {
          await indexEpubContent(epubOriginal, (row) =>
            insertContentChapter(pending.bookId, row.chapter, row.content_text, row.snippet, row.position)
          );
        }

        return NextResponse.json({
          success: true,
          book: { id: pending.bookId, title: finalTitle, author: finalAuthor, tags: body.tags ?? null, file_type: pending.fileType, progress: 0 },
        });
      }

      // ----- Step 1: presign -----
      const fileType =
        body.fileType === "epub" || body.fileType === "pdf" || body.fileType === "mp4" || body.fileType === "webm" || body.fileType === "m4v"
          ? body.fileType
          : null;
      if (!fileType) {
        return NextResponse.json(
          { success: false, message: "fileType must be 'epub', 'pdf', 'mp4', 'webm', or 'm4v'" },
          { status: 400 }
        );
      }

      const bookId = `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const presigned = await createPresignedUpload(
        bookId,
        fileType,
        fileType === "epub" ? EPUB_MIME : fileType === "pdf" ? PDF_MIME : VIDEO_MIME[fileType] || MP4_MIME
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
        storageId: presigned.storageId,
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
    const ext = name.endsWith(".epub") ? "epub" : name.endsWith(".pdf") ? "pdf" : name.endsWith(".mp4") ? "mp4" : name.endsWith(".webm") ? "webm" : name.endsWith(".m4v") ? "m4v" : null;
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

    // Cover extraction (EPUB only, best-effort) from the ORIGINAL bytes.
    // Cover must resolve BEFORE insertBook (the row carries cover_url).
    let coverUrl: string | null = null;
    let epubOriginal: Buffer | null = null;
    if (fileType === "epub") {
      epubOriginal = encoding === "gzip" ? tryDecompress(payload, "gzip") : rawBuffer;
      const cover = await extractCover("epub", epubOriginal);
      if (cover) {
        await saveCover(bookId, cover);
        coverUrl = `/api/books/${bookId}/cover`;
      }
    }

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
      cover_url: coverUrl,
      uploaded_at: Date.now(),
    });

    // Content indexing AFTER the book row exists (FK requires it).
    if (epubOriginal) {
      await indexEpubContent(epubOriginal, (row) =>
        insertContentChapter(bookId, row.chapter, row.content_text, row.snippet, row.position)
      );
    }

    return NextResponse.json({
      success: true,
      book: { id: bookId, title, author, tags, file_type: fileType, progress: 0 },
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ success: false, message: "Upload failed" }, { status: 500 });
  }
}
