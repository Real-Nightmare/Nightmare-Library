import { NextRequest, NextResponse } from "next/server";
import { recordReadingHeartbeat } from "@/lib/repo";

export const runtime = "nodejs";

/**
 * POST /api/stats/heartbeat — reading-session tracker.
 * Called periodically by the reader while a book is open. Heartbeats within
 * 5 minutes of each other extend the same session; gaps start a new one.
 * Failures are non-fatal (reader ignores the response).
 */
export async function POST(req: NextRequest) {
  try {
    let body: { bookId?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
    }
    if (!body.bookId) {
      return NextResponse.json({ success: false, message: "bookId required" }, { status: 400 });
    }
    await recordReadingHeartbeat(body.bookId, Date.now());
    return NextResponse.json({ success: true });
  } catch (error) {
    // Session tracking must never break reading.
    console.error("Heartbeat error (non-fatal):", error);
    return NextResponse.json({ success: true, degraded: true });
  }
}
