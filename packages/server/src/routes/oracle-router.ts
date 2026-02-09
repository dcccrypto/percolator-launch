import { Hono } from "hono";
import { resolvePrice, type PriceRouterResult } from "@percolator/core";

// Simple in-memory cache: mint → { result, expiresAt }
const cache = new Map<string, { result: PriceRouterResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function oracleRouterRoutes(): Hono {
  const app = new Hono();

  // GET /oracle/resolve/:mint — returns ranked oracle sources for a given token
  app.get("/oracle/resolve/:mint", async (c) => {
    const mint = c.req.param("mint");

    // Validate mint format (base58, 32-44 chars)
    if (!mint || mint.length < 32 || mint.length > 44) {
      return c.json({ error: "Invalid mint address" }, 400);
    }

    // Evict expired entries on every read
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now >= entry.expiresAt) cache.delete(key);
    }

    // Check cache
    const cached = cache.get(mint);
    if (cached && now < cached.expiresAt) {
      return c.json({ ...cached.result, cached: true });
    }

    try {
      const result = await resolvePrice(mint);

      // Cache the result
      cache.set(mint, { result, expiresAt: Date.now() + CACHE_TTL_MS });

      return c.json({ ...result, cached: false });
    } catch (err: any) {
      return c.json({ error: err.message || "Failed to resolve oracle sources" }, 500);
    }
  });

  return app;
}
