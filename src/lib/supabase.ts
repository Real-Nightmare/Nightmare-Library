import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client — env-first, recursion-safe.
 *
 * Resolution for Supabase credentials:
 * 1. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars (production default)
 * 2. Runtime overrides stored in the LOCAL libSQL KV store (used when the app
 *    runs without Supabase env, e.g. self-host switching to Supabase from the
 *    Settings page)
 *
 * We deliberately do NOT read overrides through the settings map when
 * Supabase itself is the settings store — that would recurse (reading
 * Supabase settings requires a Supabase client). Env always wins for
 * Supabase credentials, which keeps production behavior identical.
 */

let cached: { client: SupabaseClient; url: string; key: string } | null = null;

export async function getSupabaseConfig(): Promise<{ url: string; key: string } | null> {
  const envUrl = process.env.SUPABASE_URL?.trim();
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (envUrl && envKey) return { url: envUrl, key: envKey };

  // No env config — fall back to runtime overrides held in the local KV.
  const { getOverrideLocal } = await import("./appsettings");
  const url = (await getOverrideLocal("supabase_url")) ?? undefined;
  const key = (await getOverrideLocal("supabase_service_key")) ?? undefined;
  if (url && key) return { url, key };
  return null;
}

/** True when Supabase has a usable config (env or local-KV override). */
export async function isSupabaseConfigured(): Promise<boolean> {
  return (await getSupabaseConfig()) !== null;
}

export function supabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
}

export async function getSupabase(): Promise<SupabaseClient> {
  const config = await getSupabaseConfig();
  if (!config) {
    throw new Error("Supabase is not configured (env or Settings override missing)");
  }
  if (cached && cached.url === config.url && cached.key === config.key) return cached.client;

  const client = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cached = { client, url: config.url, key: config.key };
  return client;
}
