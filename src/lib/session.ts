import { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./auth";

/**
 * Session check for middleware. The token is verified from the request
 * cookie directly — no next/headers() fallback, which is not available
 * in middleware context.
 */
export async function getSession(req: NextRequest): Promise<boolean> {
  const secret = process.env.JWT_SECRET || process.env.PASSWORD;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return verifySessionToken(token, secret);
}
