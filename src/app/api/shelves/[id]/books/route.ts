import { NextRequest, NextResponse } from "next/server";
import { listShelfBooks, addBookToShelf, removeBookFromShelf } from "@/lib/repo";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/shelves/[id]/books — books on a shelf */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const books = await listShelfBooks(id);
    return NextResponse.json({ success: true, books });
  } catch (error) {
    console.error("List shelf books error:", error);
    return NextResponse.json({ success: false, message: "Failed to load shelf books" }, { status: 500 });
  }
}

/** POST /api/shelves/[id]/books — add a book */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;

    let body: { bookId?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
    }

    if (!body.bookId) {
      return NextResponse.json({ success: false, message: "bookId required" }, { status: 400 });
    }

    await addBookToShelf(id, body.bookId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Add shelf book error:", error);
    return NextResponse.json({ success: false, message: "Failed to add book to shelf" }, { status: 500 });
  }
}

/** DELETE /api/shelves/[id]/books?bookId=... — remove a book from shelf */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const bookId = req.nextUrl.searchParams.get("bookId");

    if (!bookId) {
      return NextResponse.json({ success: false, message: "bookId required" }, { status: 400 });
    }

    await removeBookFromShelf(id, bookId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Remove shelf book error:", error);
    return NextResponse.json({ success: false, message: "Failed to remove book from shelf" }, { status: 500 });
  }
}
