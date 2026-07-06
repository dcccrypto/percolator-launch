import type { MetadataRoute } from "next";

const BASE_URL = "https://percolator.trade";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: BASE_URL, changeFrequency: "daily", priority: 1.0 },
    { url: `${BASE_URL}/markets`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${BASE_URL}/create`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE_URL}/leaderboard`, changeFrequency: "hourly", priority: 0.6 },
    { url: `${BASE_URL}/developers`, changeFrequency: "weekly", priority: 0.5 },
  ];

  // Per-market /trade/[slab] routes
  let marketRoutes: MetadataRoute.Sitemap = [];
  try {
    const res = await fetch(`${BASE_URL}/api/markets`, {
      next: { revalidate: 3600 },
    });
    if (res.ok) {
      const data = await res.json();
      const markets: Array<{ slab_address: string }> = data?.markets ?? data ?? [];
      marketRoutes = markets.map((m) => ({
        url: `${BASE_URL}/trade/${m.slab_address}`,
        changeFrequency: "hourly" as const,
        priority: 0.7,
      }));
    }
  } catch {
    // Non-fatal — sitemap works without dynamic markets
  }

  return [...staticRoutes, ...marketRoutes];
}
