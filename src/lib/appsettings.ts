import { mkdirSync } from "fs";
import path from "path";
import { createClient, type Client } from "@libsql/client";

/**
 * Application settings — runtime-editable configuration stored in the
 * database itself, so the owner can swap providers or change the site
 * password from the Settings page without touching env vars.
 *
 * BOOTSTRAP RULE: the settings KV store itself is always reached through the
 * ENV-DETECTED driver (Supabase when SUPABASE_* env vars exist, otherwise
 * libSQL — env Turso or the local file). This avoids circularity: you cannot
 * use a settings override to decide where to read the settings from.
 * Everything else in the app (repo, storage, auth) resolves through the
 * resolvers below, which DO honor overrides.
 *
 * Resolution order for every key: settings override → env var → null.
 * Secret values never leave the server unmasked.
 */

export type SettingsGroup = "database" | "storage" | "password";

export interface SettingKeyDef {
  key: string;
  group: SettingsGroup;
  label: string;
  secret: boolean;
  placeholder?: string;
  hint?: string;
  /** Env var checked when no runtime override exists. */
  env: string;
}

export const SETTING_KEYS: SettingKeyDef[] = [
  // ---------- Database ----------
  { key: "db_provider", group: "database", label: "Database provider", secret: false, env: "",
    hint: "supabase = Postgres (recommended), turso = remote SQLite, local = SQLite file on the server" },
  { key: "supabase_url", group: "database", label: "Supabase project URL", secret: false, env: "SUPABASE_URL",
    placeholder: "https://xxxx.supabase.co" },
  { key: "supabase_service_key", group: "database", label: "Supabase service role key", secret: true, env: "SUPABASE_SERVICE_ROLE_KEY" },
  { key: "turso_url", group: "database", label: "Turso database URL", secret: false, env: "TURSO_DATABASE_URL",
    placeholder: "libsql://xxxx.turso.io" },
  { key: "turso_token", group: "database", label: "Turso auth token", secret: true, env: "TURSO_AUTH_TOKEN" },

  // ---------- Storage ----------
  { key: "storage_provider", group: "storage", label: "Storage provider", secret: false, env: "",
    hint: "pool = spread books across EVERY configured provider (sums their free tiers — recommended), s3 = one custom S3 provider (R2, iDrive e2, Filebase…), b2 = Backblaze B2, b2_cascade = B2 + failover, local = server disk" },
  { key: "b2_key_id", group: "storage", label: "B2 key ID", secret: true, env: "B2_KEY_ID" },
  { key: "b2_application_key", group: "storage", label: "B2 application key", secret: true, env: "B2_APPLICATION_KEY" },
  { key: "b2_bucket", group: "storage", label: "B2 bucket name", secret: false, env: "B2_BUCKET_NAME" },
  { key: "b2_region", group: "storage", label: "B2 region", secret: false, env: "B2_REGION", placeholder: "us-east-005" },
  { key: "b2_cascade_endpoint", group: "storage", label: "Cascade S3 endpoint", secret: false, env: "B2_CASCADE_ENDPOINT",
    hint: "Second S3-compatible provider used when B2 fails (full endpoint URL, e.g. https://s3.us-east-1.example.com)" },
  { key: "b2_cascade_key_id", group: "storage", label: "Cascade key ID", secret: true, env: "B2_CASCADE_KEY_ID" },
  { key: "b2_cascade_secret", group: "storage", label: "Cascade secret", secret: true, env: "B2_CASCADE_SECRET" },
  { key: "b2_cascade_bucket", group: "storage", label: "Cascade bucket", secret: false, env: "B2_CASCADE_BUCKET" },
  { key: "b2_cascade_region", group: "storage", label: "Cascade region", secret: false, env: "B2_CASCADE_REGION", placeholder: "us-east-1" },
  { key: "b2_cascade_capacity_gb", group: "storage", label: "Custom S3 #2 capacity (GB)", secret: false, env: "B2_CASCADE_CAPACITY_GB",
    hint: "Pool budget for the second custom S3 slot. Default 25 (e.g. Storj-class free tier)." },

  { key: "s3_endpoint", group: "storage", label: "Custom S3 endpoint", secret: false, env: "S3_ENDPOINT",
    placeholder: "https://<account>.r2.cloudflarestorage.com",
    hint: "Full endpoint URL of any S3-compatible provider — Cloudflare R2, Storj, iDrive e2, Filebase, Tigris…" },
  { key: "s3_region", group: "storage", label: "Custom S3 region", secret: false, env: "S3_REGION", placeholder: "auto" },
  { key: "s3_key_id", group: "storage", label: "Custom S3 access key ID", secret: true, env: "S3_ACCESS_KEY_ID" },
  { key: "s3_secret", group: "storage", label: "Custom S3 secret key", secret: true, env: "S3_SECRET_ACCESS_KEY" },
  { key: "s3_bucket", group: "storage", label: "Custom S3 bucket", secret: false, env: "S3_BUCKET" },
  { key: "s3_capacity_gb", group: "storage", label: "Custom S3 capacity (GB)", secret: false, env: "S3_CAPACITY_GB",
    hint: "Pool budget for this slot — how much of the provider's free tier to use. Default 10 (R2/iDrive e2 free tier)." },

  { key: "webdav_endpoint", group: "storage", label: "WebDAV endpoint", secret: false, env: "WEBDAV_ENDPOINT",
    placeholder: "https://app.koofr.net/dav/Koofr",
    hint: "WebDAV URL of a free-forever provider — Koofr (10GB, no card; app password in Koofr → Preferences → Password), pCloud (https://webdav.pcloud.com), Nextcloud…" },
  { key: "webdav_username", group: "storage", label: "WebDAV username", secret: false, env: "WEBDAV_USERNAME",
    hint: "Account email. For Koofr create an app-specific password (Preferences → Password) instead of your login password." },
  { key: "webdav_password", group: "storage", label: "WebDAV password", secret: true, env: "WEBDAV_PASSWORD" },
  { key: "webdav_base_path", group: "storage", label: "WebDAV folder", secret: false, env: "WEBDAV_BASE_PATH",
    placeholder: "/nightmare-library",
    hint: "Folder created inside the WebDAV account for book files. Default /nightmare-library." },
  { key: "webdav_capacity_gb", group: "storage", label: "WebDAV capacity (GB)", secret: false, env: "WEBDAV_CAPACITY_GB",
    hint: "Pool budget for this slot. Default 10 (Koofr/pCloud free tier)." },

  { key: "webdav2_endpoint", group: "storage", label: "WebDAV #2 endpoint", secret: false, env: "WEBDAV2_ENDPOINT",
    placeholder: "https://webdav.pcloud.com",
    hint: "Second free WebDAV account — e.g. Koofr in slot 1, pCloud in slot 2 = +20GB with no credit card." },
  { key: "webdav2_username", group: "storage", label: "WebDAV #2 username", secret: false, env: "WEBDAV2_USERNAME" },
  { key: "webdav2_password", group: "storage", label: "WebDAV #2 password", secret: true, env: "WEBDAV2_PASSWORD" },
  { key: "webdav2_base_path", group: "storage", label: "WebDAV #2 folder", secret: false, env: "WEBDAV2_BASE_PATH",
    placeholder: "/nightmare-library" },
  { key: "webdav2_capacity_gb", group: "storage", label: "WebDAV #2 capacity (GB)", secret: false, env: "WEBDAV2_CAPACITY_GB",
    hint: "Pool budget for the second WebDAV slot. Default 10." },

  // ---------- Password ----------
  { key: "site_password", group: "password", label: "Site password", secret: true, env: "PASSWORD",
    hint: "Leave empty to keep using the PASSWORD env var. Takes effect immediately and signs everyone out — keep it safe." },
];

const ALLOWED = new Set(SETTING_KEYS.map((k) => k.key));

// ---------------- Env-detected KV driver ----------------

function envSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

let kvClient: Client | null = null;

/** libSQL client for the KV store when Supabase env is absent. */
function getKvClient(): Client {
  if (kvClient) return kvClient;
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (url) {
    kvClient = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined });
  } else {
    mkdirSync(path.join(process.cwd(), ".data"), { recursive: true });
    kvClient = createClient({ url: "file:.data/nightmare.db" });
  }
  return kvClient;
}

// ---------------- KV read/write ----------------

export async function getSettingsMap(): Promise<Record<string, string>> {
  try {
    if (envSupabaseConfigured()) {
      const { getSupabase } = await import("./supabase");
      const sb = await getSupabase();
      const { data, error } = await sb.from("app_settings").select("key, value");
      if (error) throw new Error(error.message);
      const map: Record<string, string> = {};
      for (const row of (data || []) as { key: string; value: string }[]) {
        if (row.value != null) map[row.key] = row.value;
      }
      return map;
    }
    const res = await getKvClient().execute("SELECT key, value FROM app_settings");
    const map: Record<string, string> = {};
    for (const row of res.rows as unknown as { key: string; value: string }[]) {
      if (row.value != null) map[row.key] = row.value;
    }
    return map;
  } catch {
    // Table may not exist yet, or DB briefly unreachable — settings are an
    // enhancement and must never break the app. Env fallback still works.
    return {};
  }
}

export async function setSettings(patch: Record<string, string>): Promise<void> {
  const entries = Object.entries(patch).filter(([k, v]) => ALLOWED.has(k) && typeof v === "string");
  if (entries.length === 0) throw new Error("No valid setting keys provided");

  if (envSupabaseConfigured()) {
    const { getSupabase } = await import("./supabase");
    const sb = await getSupabase();
    for (const [key, value] of entries) {
      const { error } = await sb
        .from("app_settings")
        .upsert({ key, value: value.trim() ? value : null }, { onConflict: "key" });
      if (error) throw new Error(error.message);
    }
    return;
  }

  const db = getKvClient();
  await db.execute(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  )`);
  for (const [key, value] of entries) {
    await db.execute({
      sql: `INSERT INTO app_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now') * 1000`,
      args: [key, value.trim() ? value : null],
    });
  }
}

// ---------------- Resolution (cached) ----------------

let cache: { map: Record<string, string>; at: number } | null = null;
let cacheInflight: Promise<Record<string, string>> | null = null;
const CACHE_MS = 15_000;

async function cachedMap(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.map;
  // Single-flight: concurrent cold requests share one DB read instead of
  // stampeding it (then the fastest writer wins the cache slot).
  if (!cacheInflight) {
    cacheInflight = getSettingsMap()
      .then((map) => {
        cache = { map, at: Date.now() };
        return map;
      })
      .finally(() => {
        cacheInflight = null;
      });
  }
  return cacheInflight;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

/** Runtime override for a key (null if unset). */
export async function getOverride(key: string): Promise<string | null> {
  const map = await cachedMap();
  return map[key]?.trim() ? map[key].trim() : null;
}

/**
 * Override read from the LOCAL libSQL KV only — never routed through
 * Supabase. Used by supabase.ts when no Supabase env config exists, so
 * the Settings page can introduce Supabase credentials without recursion.
 */
export async function getOverrideLocal(key: string): Promise<string | null> {
  try {
    const res = await getKvClient().execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [key] });
    const row = res.rows[0] as unknown as { value: string | null } | undefined;
    const v = row?.value?.trim();
    return v ? v : null;
  } catch {
    return null; // table may not exist yet
  }
}

/** Resolve a setting: runtime override → env → null. */
export async function resolveSetting(key: string): Promise<string | null> {
  const def = SETTING_KEYS.find((k) => k.key === key);
  if (!def) return null;
  const override = await getOverride(key);
  if (override) return override;
  const envVal = def.env ? process.env[def.env] : undefined;
  return envVal?.trim() ? envVal.trim() : null;
}

// ---------------- Domain resolvers ----------------

export async function resolveDatabaseProvider(): Promise<"supabase" | "turso" | "local"> {
  const p = await resolveSetting("db_provider");
  if (p === "supabase" || p === "turso" || p === "local") return p;
  // Auto-detect: explicit override credentials first, then env.
  const map = await cachedMap();
  const sUrl = map["supabase_url"]?.trim() || process.env.SUPABASE_URL?.trim();
  const sKey = map["supabase_service_key"]?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (sUrl && sKey) return "supabase";
  const tUrl = map["turso_url"]?.trim() || process.env.TURSO_DATABASE_URL?.trim();
  return tUrl ? "turso" : "local";
}

export type StorageProviderId = "b2" | "b2_cascade" | "s3" | "pool" | "local";

export async function resolveStorageProvider(): Promise<StorageProviderId> {
  const p = await resolveSetting("storage_provider");
  if (p === "b2" || p === "b2_cascade" || p === "s3" || p === "pool" || p === "local") return p;
  const map = await cachedMap();
  const keyId = map["b2_key_id"]?.trim() || process.env.B2_KEY_ID?.trim();
  const appKey = map["b2_application_key"]?.trim() || process.env.B2_APPLICATION_KEY?.trim();
  const bucket = map["b2_bucket"]?.trim() || process.env.B2_BUCKET_NAME?.trim();
  if (keyId && appKey && bucket) return "b2";
  // No B2 creds — a custom S3 endpoint (R2 etc.) or local disk.
  const s3Key = map["s3_key_id"]?.trim() || process.env.S3_ACCESS_KEY_ID?.trim();
  const s3Secret = map["s3_secret"]?.trim() || process.env.S3_SECRET_ACCESS_KEY?.trim();
  const s3Bucket = map["s3_bucket"]?.trim() || process.env.S3_BUCKET?.trim();
  const s3Endpoint = map["s3_endpoint"]?.trim() || process.env.S3_ENDPOINT?.trim();
  return s3Key && s3Secret && s3Bucket && s3Endpoint ? "s3" : "local";
}

/** Effective site password: runtime override → PASSWORD env. */
export async function effectiveSitePassword(): Promise<string | null> {
  return resolveSetting("site_password");
}

/**
 * Effective session-signing secret. A custom password derives a stable
 * signing secret, so changing the password invalidates all sessions
 * (everyone must log back in — the safe behavior).
 *
 * Returns NULL when no secret is configured (no password override, no
 * JWT_SECRET, no PASSWORD). Verification must then FAIL CLOSED — a literal
 * fallback constant would let anyone forge valid session tokens on a
 * misconfigured deployment.
 */
export async function effectiveSessionSecret(): Promise<string | null> {
  const custom = await resolveSetting("site_password");
  if (custom) return `nmlr::${custom}`;
  const envSecret = process.env.JWT_SECRET?.trim() || process.env.PASSWORD?.trim();
  return envSecret || null;
}

// ---------------- Masking / API views ----------------

export function maskSecret(value: string): string {
  if (value.length <= 3) return "••••••••";
  return `${value.slice(0, 3)}${"•".repeat(Math.min(12, Math.max(4, value.length - 3)))}`;
}

export interface SettingView {
  key: string;
  group: SettingsGroup;
  label: string;
  secret: boolean;
  hint?: string;
  placeholder?: string;
  /** Masked current value (resolved), or null when unset. */
  value: string | null;
  /** True when the value comes from an env var rather than a runtime override. */
  fromEnv: boolean;
}

export async function listSettings(): Promise<SettingView[]> {
  const map = await cachedMap();
  const views: SettingView[] = [];
  for (const def of SETTING_KEYS) {
    const override = map[def.key]?.trim();
    const envVal = def.env ? process.env[def.env]?.trim() : undefined;
    const raw = override || envVal || null;
    views.push({
      key: def.key,
      group: def.group,
      label: def.label,
      secret: def.secret,
      hint: def.hint,
      placeholder: def.placeholder,
      value: raw ? (def.secret ? maskSecret(raw) : raw) : null,
      fromEnv: !override && Boolean(envVal),
    });
  }
  return views;
}
