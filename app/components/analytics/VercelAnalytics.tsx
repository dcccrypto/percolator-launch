import { Analytics } from "@vercel/analytics/next";
import { vercelAnalyticsEnabled } from "@/lib/analytics-config";

/**
 * Vercel Web Analytics, opt-in. Renders nothing unless NEXT_PUBLIC_VERCEL_ANALYTICS=1,
 * because on a project without Web Analytics enabled the script URL 404s on every page
 * (#2826). To get analytics: enable Web Analytics on the Vercel project AND set the flag.
 */
export function VercelAnalytics() {
  if (!vercelAnalyticsEnabled()) return null;
  return <Analytics />;
}
