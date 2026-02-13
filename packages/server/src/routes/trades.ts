import { Hono } from "hono";
import { getRecentTrades, get24hVolume, getGlobalRecentTrades, getPriceHistory } from "../db/queries.js";

const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function tradeRoutes(): Hono {
  const app = new Hono();

  /** Recent trades for a specific market */
  app.get("/markets/:slab/trades", async (c) => {
    const slab = c.req.param("slab");
    if (!BASE58_PUBKEY.test(slab)) {
      return c.json({ error: "Invalid slab address" }, 400);
    }
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);

    try {
      const trades = await getRecentTrades(slab, limit);
      return c.json({ trades });
    } catch (err) {
      console.error("[TradeRoutes] Error fetching trades:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to fetch trades" }, 500);
    }
  });

  /** 24h volume for a specific market */
  app.get("/markets/:slab/volume", async (c) => {
    const slab = c.req.param("slab");
    if (!BASE58_PUBKEY.test(slab)) {
      return c.json({ error: "Invalid slab address" }, 400);
    }

    try {
      const { volume, tradeCount } = await get24hVolume(slab);
      return c.json({ slab_address: slab, volume_24h: volume, trade_count_24h: tradeCount });
    } catch (err) {
      console.error("[TradeRoutes] Error fetching volume:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to fetch volume" }, 500);
    }
  });

  /** Price history for a specific market (for charts) */
  app.get("/markets/:slab/prices", async (c) => {
    const slab = c.req.param("slab");
    if (!BASE58_PUBKEY.test(slab)) {
      return c.json({ error: "Invalid slab address" }, 400);
    }

    // Default to 24h of price history
    const hoursBack = Math.min(Math.max(Number(c.req.query("hours") ?? 24), 1), 720); // max 30 days
    const sinceEpoch = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);

    try {
      const prices = await getPriceHistory(slab, sinceEpoch);
      return c.json({
        slab_address: slab,
        prices: prices.map((p) => ({
          price: Number(p.price_e6) / 1_000_000,
          price_e6: p.price_e6,
          timestamp: p.timestamp,
        })),
      });
    } catch (err) {
      console.error("[TradeRoutes] Error fetching price history:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to fetch price history" }, 500);
    }
  });

  /** Global recent trades across all markets */
  app.get("/trades/recent", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);

    try {
      const trades = await getGlobalRecentTrades(limit);
      return c.json({ trades });
    } catch (err) {
      console.error("[TradeRoutes] Error fetching global trades:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to fetch trades" }, 500);
    }
  });

  return app;
}
