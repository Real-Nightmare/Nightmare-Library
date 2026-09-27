import { NextRequest, NextResponse } from "next/server";
import {
  getOverride,
  setSettings,
  invalidateSettingsCache,
  effectiveSitePassword,
} from "@/lib/appsettings";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const runtime = "nodejs";

/** GET — has the owner set a runtime password override? */
export async function GET() {
  const override = await getOverride("site_password");
  return NextResponse.json({ success: true, usingOverride: Boolean(override) });
}

/**
 * PUT — change the site password at runtime.
 * Requires the CURRENT effective password for confirmation. Setting an empty
 * value reverts to the PASSWORD env var. Takes effect immediately; sessions
 * signed with the old secret become invalid (forced re-login everywhere).
 */
export async function PUT(req: NextRequest) {
  try {
    let body: { current?: string; next?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
    }

    const current = (body.current ?? "").trim();
    const next = (body.next ?? "").trim();

    if (next && next.length < 8) {
      return NextResponse.json({ success: false, message: "New password must be at least 8 characters" }, { status: 400 });
    }

    const effective = await effectiveSitePassword();
    if (!effective || !safeEqual(current, effective)) {
      return NextResponse.json(
        { success: false, message: "Current password is incorrect" },
        { status: 403 }
      );
    }

    await setSettings({ site_password: next });
    invalidateSettingsCache();

    return NextResponse.json({
      success: true,
      message: next
        ? "Password changed. All devices will need to sign in again."
        : "Reverted to the PASSWORD env var. All devices will need to sign in again.",
    });
  } catch (error) {
    console.error("Password change error:", error);
    return NextResponse.json({ success: false, message: "Failed to change password" }, { status: 500 });
  }
}
