import { NextRequest, NextResponse } from "next/server";
import { listShelves, createShelf, nextShelfPosition } from "@/lib/repo";

export const runtime = "nodejs";

/** GET /api/shelves — all shelves with book counts */
export async function GET() {
  try {
    const shelves = await listShelves();
    return NextResponse.json({ success: true, shelves });
  } catch (error) {
    console.error("List shelves error:", error);
    return NextResponse.json({ success: false, message: "Failed to load shelves" }, { status: 500 });
  }
}

/** POST /api/shelves — create shelf */
export async function POST(req: NextRequest) {
  try {
    let body: { name?: string; color?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
    }

    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ success: false, message: "Shelf name is required" }, { status: 400 });
    }

    const position = await nextShelfPosition();
    const shelf = await createShelf(name, body.color || "#bb86fc", position);
    return NextResponse.json({ success: true, shelf });
  } catch (error) {
    console.error("Create shelf error:", error);
    return NextResponse.json({ success: false, message: "Failed to create shelf" }, { status: 500 });
  }
}
