import { NextRequest, NextResponse } from "next/server";
import { deleteShelf } from "@/lib/repo";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** DELETE /api/shelves/[id] — remove a shelf (its items cascade). */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    await deleteShelf(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete shelf error:", error);
    return NextResponse.json({ success: false, message: "Failed to delete shelf" }, { status: 500 });
  }
}
