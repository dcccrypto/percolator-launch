import { Hono } from "hono";
import type { OracleService } from "../services/oracle.js";
import type { PriceEngine } from "../services/PriceEngine.js";

export function priceRoutes(deps: {
  oracleService: OracleService;
  priceEngine: PriceEngine;
}): Hono {
  const app = new Hono();

  // GET /prices/:slab — current price + 24h stats
  app.get("/prices/:slab", (c) => {
    const slab = c.req.param("slab");

    // Try PriceEngine first (real-time), fallback to OracleService
    const enginePrice = deps.priceEngine.getLatestPrice(slab);
    const oraclePrice = deps.oracleService.getCurrentPrice(slab);
    const price = enginePrice ?? oraclePrice;

    if (!price) {
      return c.json({ error: "No price available" }, 404);
    }

    const stats = deps.priceEngine.get24hStats(slab);

    return c.json({
      slabAddress: slab,
      priceE6: price.priceE6.toString(),
      source: price.source,
      timestamp: price.timestamp,
      stats: stats
        ? {
            high24h: stats.high24h.toString(),
            low24h: stats.low24h.toString(),
            open24h: stats.open24h.toString(),
            change24h:
              stats.open24h > 0n
                ? Number(((stats.current - stats.open24h) * 10000n) / stats.open24h) / 100
                : 0,
          }
        : null,
    });
  });

  // GET /prices/:slab/history — price history (in-memory)
  app.get("/prices/:slab/history", (c) => {
    const slab = c.req.param("slab");

    // Merge: prefer PriceEngine history, fallback to OracleService
    const engineHistory = deps.priceEngine.getHistory(slab);
    const oracleHistory = deps.oracleService.getPriceHistory(slab);
    const history = engineHistory.length > 0 ? engineHistory : oracleHistory;

    return c.json({
      slabAddress: slab,
      prices: history.map((p) => ({
        priceE6: p.priceE6.toString(),
        source: p.source,
        timestamp: p.timestamp,
      })),
    });
  });

  return app;
}
