import { NextResponse } from "next/server";
import { listBooks, getBookStorage, updateBook } from "@/lib/repo";
import { activeStorageProvider, readBookFileDecoded, saveBookFile } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * POST /api/settings/migrate — move every book stored on B2 (or its cascade)
 * to the ACTIVE storage provider, server-side: B2 → read → write to target →
 * update the row. Bytes never leave the server, and the B2 copy is KEPT as a
 * safety net (delete it manually once happy).
 *
 * Works when the active provider is Custom S3, Pool, or local disk — books
 * land wherever `saveBookFile` routes them (for the pool, each book goes to
 * the slot with the most free space).
 *
 * Returns a per-book failure list — most likely failure is B2's daily
 * download cap being exhausted, in which case re-run after midnight UTC.
 */
export async function POST() {
  try {
    const target = await activeStorageProvider();
    if (target === "b2" || target === "b2_cascade") {
      return NextResponse.json(
        { success: false, message: `Active storage is "${target}" — switch to Pool, Custom S3, or local first, then run the move.` },
        { status: 400 }
      );
    }

    const books = await listBooks();
    let migrated = 0;
    let failed = 0;
    let skipped = 0;
    const failures: string[] = [];

    for (const book of books) {
      const row = await getBookStorage(book.id);
      if (!row) {
        skipped++;
        continue;
      }
      if (row.storage_provider !== "b2" && row.storage_provider !== "b2_cascade") {
        skipped++;
        continue;
      }

      const data = await readBookFileDecoded(row.storage_provider, row.storage_id, row.file_encoding);
      if (!data || data.length === 0) {
        failed++;
        failures.push(`${row.title}: could not read from B2 (daily cap exhausted or key/bucket issue)`);
        continue;
      }

      try {
        const stored = await saveBookFile(book.id, row.file_type, data);
        if (stored.provider === "local" && (target === "s3" || target === "pool")) {
          failed++;
          failures.push(`${row.title}: target provider rejected the upload — fell back to local disk`);
          continue;
        }
        await updateBook(book.id, {
          storage_provider: stored.provider,
          storage_id: stored.storageId,
        });
        migrated++;
      } catch (err) {
        failed++;
        failures.push(`${row.title}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    return NextResponse.json({
      success: true,
      target,
      migrated,
      failed,
      skipped,
      failures: failures.slice(0, 25),
    });
  } catch (error) {
    console.error("Storage migration failed:", error);
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : "Migration failed" },
      { status: 500 }
    );
  }
}
