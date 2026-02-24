import { Hono } from "hono";
import { resolvePrice, type PriceRouterResult } from "@percolator/sdk";
import { createLogger } from "@percolator/shared";

const logger = createLogger("api:oracle-router");

// Simple in-memory cache: mint → { result, expiresAt }
const cache = new Map<string, { result: PriceRouterResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 500;

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

      // Cache the result (with max size enforcement)
      if (cache.size >= MAX_CACHE_SIZE) {
        // Delete oldest entry
        const oldestKey = cache.keys().next().value;
        if (oldestKey) cache.delete(oldestKey);
      }
      cache.set(mint, { result, expiresAt: Date.now() + CACHE_TTL_MS });

      return c.json({ ...result, cached: false });
    } catch (err: any) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("Oracle resolve error", { detail, path: c.req.path });
      return c.json({ error: "Failed to resolve oracle sources" }, 500);
    }
  });

  return app;
}
