import { NextRequest, NextResponse } from "next/server";
import {
  SETTING_KEYS,
  listSettings,
  setSettings,
  getSettingsMap,
  invalidateSettingsCache,
  resolveDatabaseProvider,
  resolveStorageProvider,
} from "@/lib/appsettings";

export const runtime = "nodejs";

/** GET /api/settings — masked settings for the Settings page. */
export async function GET() {
  try {
    const [settings, dbProvider, storageProvider] = await Promise.all([
      listSettings(),
      resolveDatabaseProvider(),
      resolveStorageProvider(),
    ]);
    return NextResponse.json({ success: true, settings, active: { db: dbProvider, storage: storageProvider } });
  } catch (error) {
    console.error("Settings load error:", error);
    return NextResponse.json({ success: false, message: "Failed to load settings" }, { status: 500 });
  }
}

/** Simulate post-save resolution for pre-save connectivity tests. */
async function mergeForTest(patch: Record<string, string>): Promise<Record<string, string>> {
  const map = await getSettingsMap();
  const merged: Record<string, string> = { ...map };
  for (const [k, v] of Object.entries(patch)) {
    if (v.trim()) merged[k] = v.trim();
    else delete merged[k];
  }
  return merged;
}

/**
 * PUT /api/settings — persist runtime overrides.
 * Empty value for a key = clear the override (falls back to env/default).
 * Connectivity is tested BEFORE saving: a bad Supabase URL/key or B2 bucket
 * is rejected instead of bricking the app.
 */
export async function PUT(req: NextRequest) {
  try {
    let body: Record<string, string>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
    }

    const validKeys = new Set(SETTING_KEYS.map((k) => k.key));
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (validKeys.has(k) && typeof v === "string") patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, message: "No valid setting keys provided" }, { status: 400 });
    }

    // ---- Supabase connectivity test (when its config is being touched) ----
    if (["db_provider", "supabase_url", "supabase_service_key"].some((k) => k in patch)) {
      const merged = await mergeForTest(patch);
      const url = merged["supabase_url"] || process.env.SUPABASE_URL;
      const key = merged["supabase_service_key"] || process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (url?.trim() && key?.trim()) {
        const { createClient } = await import("@supabase/supabase-js");
        const test = createClient(url.trim(), key.trim(), { auth: { persistSession: false } });
        const { error } = await test.from("books").select("id").limit(1);
        if (error) {
          return NextResponse.json(
            { success: false, message: `Supabase connection failed: ${error.message}` },
            { status: 400 }
          );
        }
      }
    }

    // ---- B2 connectivity test ----
    if (["storage_provider", "b2_key_id", "b2_application_key", "b2_bucket", "b2_region"].some((k) => k in patch)) {
      const merged = await mergeForTest(patch);
      const keyId = merged["b2_key_id"] || process.env.B2_KEY_ID;
      const appKey = merged["b2_application_key"] || process.env.B2_APPLICATION_KEY;
      const bucket = merged["b2_bucket"] || process.env.B2_BUCKET_NAME;
      const region = merged["b2_region"] || process.env.B2_REGION || "us-east-005";
      if (keyId?.trim() && appKey?.trim() && bucket?.trim()) {
        try {
          const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");
          const probe = new S3Client({
            region,
            endpoint: `https://s3.${region}.backblazeb2.com`,
            credentials: { accessKeyId: keyId.trim(), secretAccessKey: appKey.trim() },
          });
          await probe.send(new HeadBucketCommand({ Bucket: bucket.trim() }));
        } catch (err) {
          return NextResponse.json(
            { success: false, message: `B2 connection failed: ${err instanceof Error ? err.message : "unreachable"}` },
            { status: 400 }
          );
        }
      }
    }

    await setSettings(patch);
    invalidateSettingsCache();

    const dbProvider = await resolveDatabaseProvider();
    const storageProvider = await resolveStorageProvider();
    return NextResponse.json({ success: true, active: { db: dbProvider, storage: storageProvider } });
  } catch (error) {
    console.error("Settings save error:", error);
    return NextResponse.json({ success: false, message: "Failed to save settings" }, { status: 500 });
  }
}
