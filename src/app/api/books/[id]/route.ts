import { NextRequest, NextResponse } from "next/server";
import { getBook, deleteBookRow, getBookStorage } from "@/lib/repo";
import { deleteBookFile } from "@/lib/storage";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/books/[id] — book metadata + progress */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const book = await getBook(id);

    if (!book) {
      return NextResponse.json({ success: false, message: "Book not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, book });
  } catch (error) {
    console.error("Get book error:", error);
    return NextResponse.json({ success: false, message: "Failed to load book" }, { status: 500 });
  }
}

/** DELETE /api/books/[id] — remove book and its file */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;

    const book = await getBookStorage(id);
    if (!book) {
      return NextResponse.json({ success: false, message: "Book not found" }, { status: 404 });
    }

    await deleteBookFile(book.storage_provider, book.storage_id);
    await deleteBookRow(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete book error:", error);
    return NextResponse.json({ success: false, message: "Delete failed" }, { status: 500 });
  }
}
