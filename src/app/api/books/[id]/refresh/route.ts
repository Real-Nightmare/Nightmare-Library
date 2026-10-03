import { NextRequest, NextResponse } from "next/server";
import { getBook, getBookStorage, updateBook } from "@/lib/repo";
import { readBookFileDecoded } from "@/lib/storage";
import { extractCover, saveCover, readCover } from "@/lib/cover";
import { extractEpubMeta, readingMinutes, looksLikeFilenameTitle } from "@/lib/epubmeta";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/books/[id]/refresh — re-read the stored file and repair the row.
 *
 * Books uploaded before cover extraction and EPUB metadata parsing existed
 * have a `cover_url` that 404s and a hand-typed (or filename-derived) title.
 * Rather than making the owner re-upload twelve light novels, this re-derives
 * both straight from the bytes already in storage:
 *
 *   - cover art   → extracted + written to B2 so the next grid load hits it
 *   - title/author → dc:title / dc:creator from the OPF package document
 *   - reading time → from the book's own word count
 *
 * Only fields that are missing or obviously placeholder get overwritten, so a
 * title the owner curated by hand is never clobbered.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    // Auth is enforced for every non-public route by src/middleware.ts.
    const { id } = await params;
    const book = await getBook(id);
    const stored = await getBookStorage(id);
    if (!book || !stored) {
      return NextResponse.json({ success: false, message: "Book not found" }, { status: 404 });
    }

    const data = await readBookFileDecoded(stored.storage_provider, stored.storage_id, stored.file_encoding);
    if (!data) {
      return NextResponse.json({ success: false, message: "Could not read the stored file" }, { status: 500 });
    }

    const changes: string[] = [];
    const fields: Parameters<typeof updateBook>[1] = {};
    let minutes: number | null = null;

    if (stored.file_type === "epub") {
      // --- cover art ---
      const existing = await readCover(id);
      if (!existing) {
        const cover = await extractCover("epub", data);
        if (cover) {
          await saveCover(id, cover);
          changes.push("cover");
        }
      }

      // --- metadata ---
      const meta = await extractEpubMeta(data);
      if (meta) {
        minutes = meta.wordCount > 0 ? readingMinutes(meta.wordCount) : null;
        const titleLooksPlaceholder = looksLikeFilenameTitle(book.title);
        const authorMissing = !book.author || book.author.trim().toLowerCase() === "unknown hand";
        if (meta.title && titleLooksPlaceholder && meta.title !== book.title) {
          fields.title = meta.title;
          changes.push("title");
        }
        if (meta.author && authorMissing) {
          fields.author = meta.author;
          changes.push("author");
        }
      }
    }

    if (Object.keys(fields).length > 0) await updateBook(id, fields);

    return NextResponse.json({
      success: true,
      changed: changes,
      minutes,
      title: fields.title ?? book.title,
      author: fields.author ?? book.author,
    });
  } catch (error) {
    console.error("Refresh book error:", error);
    return NextResponse.json({ success: false, message: "Refresh failed" }, { status: 500 });
  }
}
