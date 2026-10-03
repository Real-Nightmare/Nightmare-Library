import { NextRequest, NextResponse } from "next/server";
import { listShelves, listShelfJacket } from "@/lib/repo";
import { detectVolume } from "@/lib/sortorder";
import { listAnnotatedBooks } from "@/lib/notestore";

export const runtime = "nodejs";

/**
 * GET /api/shelves — every shelf with the book a reader would expect on its
 * jacket: the most recently READ volume (falling back to the highest volume
 * in the shelf, then to whatever is in there at all). A shelf of a finished
 * series should show volume 12 on the cover, not whichever file happened to
 * be added first.
 */
export async function GET(_req: NextRequest) {
  try {
    const [shelves, annotated] = await Promise.all([listShelves(), listAnnotatedBooks()]);

    const withJackets = await Promise.all(
      shelves.map(async (s) => {
        const books = await listShelfJacket(s.id);
        const withProgress = books.filter((b) => (b.progress || 0) > 0);
        const pool = withProgress.length > 0 ? withProgress : books;

        const jacket =
          pool.slice().sort((a, b) => {
            // Most recent read wins among books that have been opened.
            if (a.last_read_at && b.last_read_at) return b.last_read_at - a.last_read_at;
            if (a.last_read_at) return -1;
            if (b.last_read_at) return 1;
            // Otherwise the furthest / highest volume is the sensible jacket.
            return (b.progress || 0) - (a.progress || 0) || (detectVolume(b.title) || 0) - (detectVolume(a.title) || 0);
          })[0] ?? null;

        const totalProgress = books.reduce((sum, b) => sum + (b.progress || 0), 0);

        return {
          ...s,
          jacket: jacket
            ? {
                id: jacket.id,
                title: jacket.title,
                author: jacket.author,
                cover_url: jacket.cover_url,
                file_type: jacket.file_type,
                media_type: jacket.media_type,
                progress: jacket.progress,
                volume: detectVolume(jacket.title),
                last_read_at: jacket.last_read_at,
              }
            : null,
          /** 0-100 across the whole shelf, for the jacket's progress ring. */
          shelfProgress: books.length ? Math.round(totalProgress / books.length) : 0,
          /** Which volumes the shelf holds and how far each one is, so the
           *  card can say "up next: vol 9" without the reader counting. */
          entries: books
            .map((b) => ({ id: b.id, volume: detectVolume(b.title), progress: b.progress || 0 }))
            .filter((e): e is { id: string; volume: number; progress: number } => e.volume != null)
            .sort((a, b) => a.volume - b.volume),
          /** Membership ids, so the client can find books on no shelf at all
           *  without N round-trips. */
          bookIds: books.map((b) => b.id),
          highlights: books.reduce((sum, b) => sum + (annotated[b.id] || 0), 0),
        };
      })
    );

    return NextResponse.json({ success: true, shelves: withJackets });
  } catch (error) {
    console.error("Shelves error:", error);
    return NextResponse.json({ success: false, message: "Failed to load shelves" }, { status: 500 });
  }
}
