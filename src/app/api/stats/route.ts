import { NextResponse } from "next/server";
import { getStats } from "@/lib/repo";
import { activeStorageProvider } from "@/lib/storage";

export const runtime = "nodejs";

/** GET /api/stats — library stats (counts, pages, favorites, storage) */
export async function GET() {
  try {
    const stats = await getStats();
    return NextResponse.json({
      success: true,
      stats: { ...stats, storageProvider: activeStorageProvider() },
    });
  } catch (error) {
    console.error("Stats error:", error);
    return NextResponse.json({ success: false, message: "Failed to load stats" }, { status: 500 });
  }
}
