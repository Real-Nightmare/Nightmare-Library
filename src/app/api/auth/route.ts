import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  checkPassword,
  checkRateLimit,
  recordFailedAttempt,
  clearAttempts,
  createSessionToken,
  getClientIp,
  sessionCookieOptions,
} from "@/lib/auth";

export const runtime = "nodejs";

/** POST /api/auth — login */
export async function POST(req: NextRequest) {
  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
  }

  const ip = getClientIp(req.headers);
  const limit = await checkRateLimit(ip);
  if (!limit.allowed) {
    return NextResponse.json(
      { success: false, message: "Too many attempts. Try again in 15 minutes.", locked: true },
      { status: 429 }
    );
  }

  const { password } = body;
  if (!password) {
    return NextResponse.json({ success: false, message: "Password required" }, { status: 400 });
  }

  if (!(await checkPassword(password))) {
    const remaining = await recordFailedAttempt(ip);
    return NextResponse.json(
      { success: false, message: "Invalid credentials", attemptsRemaining: remaining },
      { status: 401 }
    );
  }

  await clearAttempts(ip);
  // Signing secret honors a runtime password override (from Settings).
  // No secret configured → refuse to mint a token (fail closed).
  const { effectiveSessionSecret } = await import("@/lib/appsettings");
  const secret = await effectiveSessionSecret();
  if (!secret) {
    return NextResponse.json(
      { success: false, message: "Server misconfigured: no signing secret (set PASSWORD)" },
      { status: 500 }
    );
  }
  const token = await createSessionToken(secret);
  const res = NextResponse.json({ success: true, redirect: "/dashboard" });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  return res;
}

/** DELETE /api/auth — logout */
export async function DELETE() {
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 });
  return res;
}
