import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Route protection for all pages and APIs.
 * - Pages (dashboard/reader): redirect to / when unauthenticated
 * - APIs: 401 JSON
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isPublic =
    pathname === "/" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/assets") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.webmanifest";

  if (isPublic) return NextResponse.next();

  const session = await getSession(req);

  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { success: false, message: "Unauthorized" },
      { status: 401 }
    );
  }

  const loginUrl = new URL("/", req.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // everything except Next.js internals and public assets
    "/((?!_next/static|_next/image|favicon.ico|assets|manifest.webmanifest|api/auth).*)",
  ],
};
