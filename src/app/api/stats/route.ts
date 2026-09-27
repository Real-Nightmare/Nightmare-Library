import { NextResponse } from "next/server";
import { getStats, getReadingActivity } from "@/lib/repo";
import { activeStorageProvider } from "@/lib/storage";

export const runtime = "nodejs";

/** GET /api/stats — library stats (counts, pages, favorites, storage, activity) */
export async function GET() {
  try {
    const [stats, storageProvider, activity] = await Promise.all([
      getStats(),
      activeStorageProvider(),
      getReadingActivity(14).catch(() => []),
    ]);
    return NextResponse.json({
      success: true,
      stats: { ...stats, storageProvider, activity },
    });
  } catch (error) {
    console.error("Stats error:", error);
    return NextResponse.json({ success: false, message: "Failed to load stats" }, { status: 500 });
  }
}
