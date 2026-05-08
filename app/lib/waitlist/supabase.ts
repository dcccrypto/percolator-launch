import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Waitlist-specific Supabase client.
 *
 * Uses a separate Supabase project from the trading frontend so the
 * waitlist landing page on percolator.trade can stay isolated from the
 * trading data on mainnet.percolatorlaunch.com.
 *
 * Env vars (set on Vercel project, separate from existing
 * NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY):
 *   NEXT_PUBLIC_WAITLIST_SUPABASE_URL
 *   NEXT_PUBLIC_WAITLIST_SUPABASE_KEY  (publishable / anon)
 *
 * Schema lives at /supabase-waitlist-schema.sql at the repo root.
 */

let _client: SupabaseClient | null = null;

export function getWaitlistSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_WAITLIST_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_WAITLIST_SUPABASE_KEY;

  if (!url || !key) {
    throw new Error(
      "Waitlist Supabase env vars not set: NEXT_PUBLIC_WAITLIST_SUPABASE_URL and NEXT_PUBLIC_WAITLIST_SUPABASE_KEY are required.",
    );
  }

  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _client;
}
