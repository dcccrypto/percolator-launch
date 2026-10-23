"use client";

import { track as vercelTrack } from "@vercel/analytics";
import { GA_ID, vercelAnalyticsEnabled } from "@/lib/analytics-config";

type AllowedValue = string | number | boolean | null;
export type EventProps = Record<string, AllowedValue | undefined>;

/**
 * Fire a conversion event to GA4 (gtag) and Vercel Web Analytics.
 *
 * (Cloudflare Web Analytics is pageview/RUM only — no custom-event API — so it
 * isn't a target here.) Safe to call anywhere on the client; no-ops on the
 * server and when a provider isn't loaded. Never throws.
 */
export function track(event: string, props?: EventProps): void {
  if (typeof window === "undefined") return;

  const clean: Record<string, AllowedValue> = {};
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v !== undefined) clean[k] = v;
    }
  }

  // Vercel Web Analytics (custom events) — only when opted in (see vercelAnalyticsEnabled)
  if (vercelAnalyticsEnabled()) {
    try {
      vercelTrack(event, clean);
    } catch {
      /* noop */
    }
  }

  // GA4 (gtag)
  try {
    const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    if (GA_ID && typeof gtag === "function") gtag("event", event, clean);
  } catch {
    /* noop */
  }
}
