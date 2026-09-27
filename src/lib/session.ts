import { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./auth";

/**
 * Session check for middleware. Verified against the EFFECTIVE signing
 * secret (a runtime password override re-signs everyone out on change).
 */
export async function getSession(req: NextRequest): Promise<boolean> {
  const { effectiveSessionSecret } = await import("./appsettings");
  const secret = await effectiveSessionSecret();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return verifySessionToken(token, secret);
}
