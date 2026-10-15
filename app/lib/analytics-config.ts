/**
 * Analytics configuration — safe to import from both server and client components.
 *
 * NEXT_PUBLIC_* vars are inlined at build time. When the key is unset, GA4 is
 * simply not initialized (no errors, no network calls), so the app builds and
 * runs cleanly before the owner adds credentials. Vercel Web Analytics is enabled
 * in the Vercel dashboard AND opted into here with NEXT_PUBLIC_VERCEL_ANALYTICS=1.
 */
// GA4 Measurement ID. This is public (it ships in client HTML on every page), so
// the project's id is a safe committed default; NEXT_PUBLIC_GA_ID overrides it.
export const GA_ID = process.env.NEXT_PUBLIC_GA_ID || "G-1SPWXBNZVP";

export const gaEnabled = Boolean(GA_ID);

// Cloudflare Web Analytics beacon token (Cloudflare dashboard → Web Analytics →
// your site → "JS snippet" → the value of data-cf-beacon `token`). Public, safe
// to commit; set as default once known. The beacon renders only when present.
export const CF_BEACON_TOKEN =
  process.env.NEXT_PUBLIC_CF_BEACON_TOKEN || "bdffc34064dd46f1a1d4aeeb39aa4db5";
export const cfAnalyticsEnabled = Boolean(CF_BEACON_TOKEN);

/**
 * Vercel Web Analytics opt-in. Off unless NEXT_PUBLIC_VERCEL_ANALYTICS === "1": on a
 * Vercel project where Web Analytics is not enabled, its script URL 404s on every page.
 * Read per call (Next still inlines the literal at build time).
 */
export function vercelAnalyticsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VERCEL_ANALYTICS === "1";
}

/** Canonical conversion-event names. Keep stable — renames break funnels/dashboards. */
export const ANALYTICS_EVENTS = {
  WAITLIST_SUBMITTED: "waitlist_submitted",
  WAITLIST_JOINED: "waitlist_joined",
  REFERRAL_LANDED: "referral_landed",
  WALLET_CONNECTED: "wallet_connected",
  MARKET_CREATED: "market_created",
  TRADE_CTA_CLICKED: "trade_cta_clicked",
} as const;

export type AnalyticsEvent =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];
