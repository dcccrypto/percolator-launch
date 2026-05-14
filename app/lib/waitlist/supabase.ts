import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Waitlist Supabase clients.
 *
 * The waitlist uses a separate Supabase project from the trading frontend
 * so the landing page on percolator.trade stays isolated from the trading
 * data on mainnet.percolatorlaunch.com.
 *
 * Env vars (set on the Vercel project, separate from the trading-DB ones):
 *   NEXT_PUBLIC_WAITLIST_SUPABASE_URL
 *   NEXT_PUBLIC_WAITLIST_SUPABASE_KEY        — publishable / anon
 *   WAITLIST_SUPABASE_SERVICE_ROLE_KEY       — server-only, bypasses RLS
 *
 * Schema lives at /supabase-waitlist-schema.sql at the repo root.
 */

let _anonClient: SupabaseClient | null = null;
let _serviceClient: SupabaseClient | null = null;

/**
 * Anonymous client — used for inserts gated by the "anon insert" RLS policy.
 * SELECT is denied; reads need either a SECURITY DEFINER RPC or the service
 * client.
 */
export function getWaitlistSupabase(): SupabaseClient {
  if (_anonClient) return _anonClient;

  const url = process.env.NEXT_PUBLIC_WAITLIST_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_WAITLIST_SUPABASE_KEY;

  if (!url || !key) {
    throw new Error(
      "Waitlist Supabase env vars not set: NEXT_PUBLIC_WAITLIST_SUPABASE_URL and NEXT_PUBLIC_WAITLIST_SUPABASE_KEY are required.",
    );
  }

  _anonClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _anonClient;
}

/**
 * Service-role client — bypasses RLS. Server-only.
 *
 * Used by the signup route to read back a row's referral_code on idempotent
 * re-submit (anon SELECT is denied for privacy, so we can't fetch via the
 * anon client). The key is never exposed to the browser.
 */
export function getWaitlistServiceSupabase(): SupabaseClient {
  if (_serviceClient) return _serviceClient;

  const url = process.env.NEXT_PUBLIC_WAITLIST_SUPABASE_URL;
  const key = process.env.WAITLIST_SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Waitlist service Supabase env vars not set: NEXT_PUBLIC_WAITLIST_SUPABASE_URL and WAITLIST_SUPABASE_SERVICE_ROLE_KEY are required.",
    );
  }

  _serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _serviceClient;
}
