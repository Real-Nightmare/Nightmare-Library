import { NextRequest, NextResponse } from "next/server";
import { searchBookContent } from "@/lib/repo";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/books/[id]/search?q=... — search indexed book content */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const q = req.nextUrl.searchParams.get("q")?.trim();

    if (!q || q.length < 2) {
      return NextResponse.json({ success: true, results: [] });
    }

    const results = await searchBookContent(id, q);
    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json({ success: false, message: "Search failed" }, { status: 500 });
  }
}
