/**
 * Dynamic sitemap for percolatorlaunch.com.
 *
 * Generates static app routes plus dynamic market trade pages.
 * Fixes GH#1756 — robots.txt referenced /sitemap.xml which returned 404
 * because this file was never implemented.
 *
 * Next.js 13+ app-dir convention: export a default async function from
 * app/sitemap.ts and the framework serialises it to /sitemap.xml automatically.
 */
import { MetadataRoute } from "next";
import { getServiceClient } from "@/lib/supabase";

/** Canonical base URL — VERCEL_URL is set by Vercel in all environments. */
function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://percolatorlaunch.com";
}

/** Static app routes that should always be indexed. */
const STATIC_ROUTES = [
  { path: "/", priority: 1.0, changeFrequency: "hourly" as const },
  { path: "/markets", priority: 0.9, changeFrequency: "hourly" as const },
  { path: "/trade", priority: 0.8, changeFrequency: "always" as const },
  { path: "/earn", priority: 0.7, changeFrequency: "daily" as const },
  { path: "/leaderboard", priority: 0.6, changeFrequency: "hourly" as const },
  { path: "/launch", priority: 0.7, changeFrequency: "weekly" as const },
  { path: "/developers", priority: 0.5, changeFrequency: "monthly" as const },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = getBaseUrl();
  const now = new Date();

  // Static routes
  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  }));

  // Dynamic market trade pages — fetch active slab addresses from Supabase
  let marketEntries: MetadataRoute.Sitemap = [];
  try {
    const supabase = getServiceClient();
    const { data: markets, error } = await supabase
      .from("markets")
      .select("slab_address, updated_at")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(500); // cap to avoid oversized sitemap

    if (!error && markets) {
      marketEntries = markets.map((m) => ({
        url: `${base}/trade/${m.slab_address}`,
        lastModified: m.updated_at ? new Date(m.updated_at) : now,
        changeFrequency: "always" as const,
        priority: 0.8,
      }));
    }
  } catch {
    // Non-fatal — return static routes only if DB is unavailable
  }

  return [...staticEntries, ...marketEntries];
}
