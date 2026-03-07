/**
 * Funding Rate API Routes
 * 
 * Exposes funding rate data for markets:
 * - Current funding rate (bps/slot)
 * - Annualized/hourly/daily rates
 * - Net LP position (inventory)
 * - Funding index (cumulative)
 * - 24h historical funding data
 */
import { Hono } from "hono";
import { validateSlab } from "../middleware/validateSlab.js";
import { cacheMiddleware } from "../middleware/cache.js";
import { 
  getFundingHistory, 
  getFundingHistorySince,
  getSupabase,
  createLogger,
} from "@percolator/shared";

const logger = createLogger("api:funding");

/**
 * Maximum valid funding rate in bps/slot (matches on-chain guard).
 * Raw DB values outside [-MAX, MAX] are garbage from uninitialized slabs.
 * Returns 0 for garbage values to avoid rendering astronomical percentages.
 */
const MAX_FUNDING_RATE_BPS = 10_000;
function sanitizeFundingRateBps(raw: number): number {
  if (!Number.isFinite(raw) || Math.abs(raw) > MAX_FUNDING_RATE_BPS) return 0;
  return raw;
}

export function fundingRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /funding/global
   * 
   * Returns current funding rates for all markets.
   * NOTE: This must come BEFORE /funding/:slab to avoid :slab matching "global"
   */
  app.get("/funding/global", async (c) => {
    try {
      const { data: allStats, error } = await getSupabase()
        .from("market_stats")
        .select("slab_address, funding_rate, net_lp_pos");

      if (error) throw error;

      const SLOTS_PER_HOUR = 9000;
      const SLOTS_PER_DAY = 216000;

      const markets = (allStats ?? []).map((stats) => {
        const rateBps = sanitizeFundingRateBps(Number(stats.funding_rate ?? 0));
        return {
          slabAddress: stats.slab_address,
          currentRateBpsPerSlot: rateBps,
          hourlyRatePercent: Number(((rateBps / 10000.0) * SLOTS_PER_HOUR).toFixed(6)),
          dailyRatePercent: Number(((rateBps / 10000.0) * SLOTS_PER_DAY).toFixed(4)),
          netLpPosition: stats.net_lp_pos ?? "0",
        };
      });

      return c.json({
        count: markets.length,
        markets,
      });
    } catch (err) {
      logger.error("Error fetching global funding data", { error: err });
      return c.json({ 
        error: "Failed to fetch global funding data",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
    }
  });

  /**
   * GET /funding/:slab — 30s cache
   * 
   * Returns current funding rate data and 24h history for a market.
   * 
   * Response format:
   * {
   *   "currentRateBpsPerSlot": 5,
   *   "hourlyRatePercent": 0.42,
   *   "dailyRatePercent": 10.08,
   *   "annualizedPercent": 3679.2,
   *   "netLpPosition": "1500000",
   *   "fundingIndexQpbE6": "123456789",
   *   "lastUpdatedSlot": 123456789,
   *   "last24hHistory": [
   *     { "timestamp": "2025-02-14T12:00:00Z", "rateBpsPerSlot": 5, "priceE6": 150000000 }
   *   ]
   * }
   */
  app.get("/funding/:slab", cacheMiddleware(30), validateSlab, async (c) => {
    const slab = c.req.param("slab");
    if (!slab) return c.json({ error: "slab required" }, 400);

    try {
      // Fetch current funding rate from market_stats
      const { data: stats, error: statsError } = await getSupabase()
        .from("market_stats")
        .select("funding_rate, net_lp_pos")
        .eq("slab_address", slab)
        .single();

      if (statsError && statsError.code !== "PGRST116") {
        throw statsError;
      }

      if (!stats) {
        return c.json({ 
          error: "Market stats not found",
          hint: "Market may not have been cranked yet or does not exist"
        }, 404);
      }

      // Parse current funding data
      const currentRateBpsPerSlot = stats.funding_rate ?? 0;
      const netLpPosition = stats.net_lp_pos ?? "0";

      // Calculate rates
      // Solana slots: ~2.5 slots/second = 400ms per slot
      // Hourly: 3600s / 0.4s = 9000 slots
      // Daily: 24 * 9000 = 216,000 slots
      // Annual: 365 * 216,000 = 78,840,000 slots
      const SLOTS_PER_HOUR = 9000;
      const SLOTS_PER_DAY = 216000;
      const SLOTS_PER_YEAR = 78840000;

      const rateBps = sanitizeFundingRateBps(Number(currentRateBpsPerSlot));
      const hourlyRatePercent = (rateBps / 10000.0) * SLOTS_PER_HOUR;
      const dailyRatePercent = (rateBps / 10000.0) * SLOTS_PER_DAY;
      const annualizedPercent = (rateBps / 10000.0) * SLOTS_PER_YEAR;

      // Fetch 24h funding history
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const history = await getFundingHistorySince(slab, since24h);

      // Format history for response
      const last24hHistory = history.map((h) => ({
        timestamp: h.timestamp,
        slot: h.slot,
        rateBpsPerSlot: h.rate_bps_per_slot,
        netLpPos: h.net_lp_pos,
        priceE6: h.price_e6,
        fundingIndexQpbE6: h.funding_index_qpb_e6,
      }));

      return c.json({
        slabAddress: slab,
        currentRateBpsPerSlot: rateBps,
        hourlyRatePercent: Number(hourlyRatePercent.toFixed(6)),
        dailyRatePercent: Number(dailyRatePercent.toFixed(4)),
        annualizedPercent: Number(annualizedPercent.toFixed(2)),
        netLpPosition,
        last24hHistory,
        metadata: {
          dataPoints24h: last24hHistory.length,
          explanation: {
            rateBpsPerSlot: "Funding rate in basis points per slot (1 bps = 0.01%)",
            hourly: "Rate * 9,000 slots/hour (assumes 400ms slots)",
            daily: "Rate * 216,000 slots/day",
            annualized: "Rate * 78,840,000 slots/year",
            sign: "Positive = longs pay shorts | Negative = shorts pay longs",
            inventory: "Driven by net LP position (LP inventory imbalance)",
          }
        }
      });
    } catch (err) {
      logger.error("Error fetching funding data", { slab, error: err });
      return c.json({ 
        error: "Failed to fetch funding data",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
    }
  });

  /**
   * GET /funding/:slab/history
   * 
   * Returns historical funding rate data with optional time range.
   * Query params:
   * - limit: number of records (default 100, max 1000)
   * - since: ISO timestamp (default: 24h ago)
   */
  app.get("/funding/:slab/history", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    if (!slab) return c.json({ error: "slab required" }, 400);
    const limitParam = c.req.query("limit");
    const sinceParam = c.req.query("since");

    try {
      let history;
      const limit = limitParam ? Math.min(parseInt(limitParam, 10), 1000) : 100;

      if (sinceParam) {
        history = await getFundingHistorySince(slab, sinceParam);
      } else {
        history = await getFundingHistory(slab, limit);
      }

      return c.json({
        slabAddress: slab,
        count: history.length,
        history: history.map((h) => ({
          timestamp: h.timestamp,
          slot: h.slot,
          rateBpsPerSlot: h.rate_bps_per_slot,
          netLpPos: h.net_lp_pos,
          priceE6: h.price_e6,
          fundingIndexQpbE6: h.funding_index_qpb_e6,
        })),
      });
    } catch (err) {
      logger.error("Error fetching funding history", { slab, error: err });
      return c.json({ 
        error: "Failed to fetch funding history",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
    }
  });

  return app;
}
