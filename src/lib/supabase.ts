import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client.
 *
 * Uses the SERVICE ROLE key — server-only, bypasses RLS. Never import this
 * from client components and never expose the service key to the browser.
 *
 * Env vars:
 * - SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) — project URL
 * - SUPABASE_SERVICE_ROLE_KEY — server-side secret
 * - SUPABASE_ANON_KEY — accepted but unused server-side
 */

let client: SupabaseClient | null = null;

export function supabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = supabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)");
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
