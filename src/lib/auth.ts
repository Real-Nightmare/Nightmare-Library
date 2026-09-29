import {
  getLoginAttempts,
  upsertLoginAttempts,
  clearLoginAttempts,
} from "./repo";

/**
 * Single-password authentication for the private library.
 *
 * - Password from `PASSWORD` env (set in Freebuff Settings → Environment)
 * - Sessions: signed HMAC token in an HttpOnly cookie, stateless.
 *   400-day TTL (the browser cookie cap): one sign-in keeps you in until
 *   you explicitly log out or clear cookies — no forced re-logins.
 * - Rate limiting: 10 failed attempts per IP per 15-minute window
 *   (Supabase Postgres in production, libSQL file in dev)
 */

export const SESSION_COOKIE = "NMLR_SESSION";
const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000; // 400 days — browser max-age cap
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

async function hmac(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signs `payload|expiresAt` — format: `<payload>.<expiresAt>.<signature>` */
export async function createSessionToken(secret: string): Promise<string> {
  const payload = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const signature = await hmac(secret, `${payload}.${expiresAt}`);
  return `${payload}.${expiresAt}.${signature}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string | undefined
): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [payload, expiresAt, signature] = parts;
  if (Number(expiresAt) < Date.now()) return false;
  const expected = await hmac(secret, `${payload}.${expiresAt}`);
  return safeEqual(signature, expected);
}/**
 * Password check against the EFFECTIVE site password: runtime override from
 * Settings first, then the PASSWORD env var.
 */
export async function checkPassword(password: string): Promise<boolean> {
  const { effectiveSitePassword } = await import("./appsettings");
  const expected = await effectiveSitePassword();
  if (!expected) {
    console.error("No site password configured (settings override or PASSWORD env) — login disabled");
    return false;
  }
  return safeEqual(password, expected);
}

export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  // Best-effort: if the rate-limit table is unreachable, allow the attempt.
  try {
    const current = await getLoginAttempts(ip);
    if (!current || Date.now() - Number(current.window_start) > WINDOW_MS) {
      return { allowed: true, remaining: MAX_ATTEMPTS };
    }
    const count = Number(current.count);
    return {
      allowed: count < MAX_ATTEMPTS,
      remaining: Math.max(0, MAX_ATTEMPTS - count),
    };
  } catch (error) {
    console.error("Rate limit read failed (non-fatal):", error);
    return { allowed: true, remaining: MAX_ATTEMPTS };
  }
}

export async function recordFailedAttempt(ip: string): Promise<number> {
  // Rate limiting is best-effort: a storage hiccup must never block login.
  try {
    const now = Date.now();
    const current = await getLoginAttempts(ip);

    if (!current || now - Number(current.window_start) > WINDOW_MS) {
      await upsertLoginAttempts(ip, 1, now);
      return MAX_ATTEMPTS - 1;
    }

    const count = Number(current.count) + 1;
    await upsertLoginAttempts(ip, count, Number(current.window_start));
    return Math.max(0, MAX_ATTEMPTS - count);
  } catch (error) {
    console.error("Rate limit write failed (non-fatal):", error);
    return MAX_ATTEMPTS;
  }
}

export async function clearAttempts(ip: string): Promise<void> {
  try {
    await clearLoginAttempts(ip);
  } catch {
    // non-fatal
  }
}

export function getClientIp(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ||
    headers.get("x-real-ip") ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_MS / 1000,
};
