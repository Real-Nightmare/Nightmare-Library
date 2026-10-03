import { NextRequest, NextResponse } from "next/server";
import { addNote, deleteNote, listNotes, updateNote } from "@/lib/notestore";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET    /api/books/[id]/notes — every highlight, note and bookmark
 * POST   /api/books/[id]/notes — add a highlight or a bookmark
 * PATCH  /api/books/[id]/notes — edit the note text on one entry
 * DELETE /api/books/[id]/notes?id=… — remove one entry
 *
 * Auth is enforced for every non-public route by src/middleware.ts.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  return NextResponse.json({ success: true, notes: await listNotes(id) });
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const body = await req.json();
    const note = await addNote(id, {
      kind: body.kind,
      text: body.text,
      note: body.note,
      anchor: body.anchor,
      chapter: body.chapter,
      percent: body.percent,
      color: body.color,
    });
    return NextResponse.json({ success: true, note });
  } catch (error) {
    console.error("Add note error:", error);
    return NextResponse.json({ success: false, message: "Could not save that highlight" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const body = await req.json();
    if (!body.id) return NextResponse.json({ success: false, message: "id is required" }, { status: 400 });
    const note = await updateNote(id, body.id, { note: body.note, color: body.color });
    if (!note) return NextResponse.json({ success: false, message: "Note not found" }, { status: 404 });
    return NextResponse.json({ success: true, note });
  } catch (error) {
    console.error("Update note error:", error);
    return NextResponse.json({ success: false, message: "Could not update that note" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const noteId = req.nextUrl.searchParams.get("id");
    if (!noteId) return NextResponse.json({ success: false, message: "id is required" }, { status: 400 });
    const removed = await deleteNote(id, noteId);
    if (!removed) return NextResponse.json({ success: false, message: "Note not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete note error:", error);
    return NextResponse.json({ success: false, message: "Could not delete that note" }, { status: 500 });
  }
}
