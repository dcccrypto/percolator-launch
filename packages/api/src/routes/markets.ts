import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { validateSlab } from "../middleware/validateSlab.js";
import { cacheMiddleware } from "../middleware/cache.js";
import { withDbCacheFallback } from "../middleware/db-cache-fallback.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine } from "@percolator/sdk";
import { getConnection, getSupabase, createLogger, sanitizeSlabAddress } from "@percolator/shared";

const logger = createLogger("api:markets");

export function marketRoutes(): Hono {
  const app = new Hono();

  // GET /markets — list all markets from Supabase (uses markets_with_stats view for performance)
  app.get("/markets", async (c) => {
    const result = await withDbCacheFallback(
      "markets:all",
      async () => {
        // Use the markets_with_stats view for a single optimized query
        const { data, error } = await getSupabase()
          .from("markets_with_stats")
          .select("*");

        if (error) throw error;

        return (data ?? []).map((m) => ({
          slabAddress: m.slab_address,
          mintAddress: m.mint_address,
          symbol: m.symbol,
          name: m.name,
          decimals: m.decimals,
          deployer: m.deployer,
          oracleAuthority: m.oracle_authority,
          initialPriceE6: m.initial_price_e6,
          maxLeverage: m.max_leverage,
          tradingFeeBps: m.trading_fee_bps,
          lpCollateral: m.lp_collateral,
          matcherContext: m.matcher_context,
          status: m.status,
          logoUrl: m.logo_url,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
          // Stats from the view
          totalOpenInterest: m.total_open_interest ?? null,
          totalAccounts: m.total_accounts ?? null,
          lastCrankSlot: m.last_crank_slot ?? null,
          lastPrice: m.last_price ?? null,
          markPrice: m.mark_price ?? null,
          indexPrice: m.index_price ?? null,
          fundingRate: m.funding_rate ?? null,
          netLpPos: m.net_lp_pos ?? null,
        }));
      },
      c
    );
    
    // If result is a Response (error case), return it directly
    if (result instanceof Response) {
      return result;
    }
    
    return c.json({ markets: result });
  });

  // GET /markets/stats — all market stats from DB
  app.get("/markets/stats", async (c) => {
    try {
      const { data, error } = await getSupabase().from("market_stats").select("*");
      if (error) throw error;
      return c.json({ stats: data ?? [] });
    } catch (err) {
      return c.json({ error: "Failed to fetch market stats" }, 500);
    }
  });

  // GET /markets/:slab/stats — single market stats from DB
  app.get("/markets/:slab/stats", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    try {
      const { data, error } = await getSupabase()
        .from("market_stats")
        .select("*")
        .eq("slab_address", slab)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return c.json({ stats: data ?? null });
    } catch (err) {
      return c.json({ error: "Failed to fetch market stats" }, 500);
    }
  });

  // GET /markets/:slab — single market details (on-chain read) — 10s cache
  app.get("/markets/:slab", cacheMiddleware(10), validateSlab, async (c) => {
    const slab = c.req.param("slab");
    try {
      const connection = getConnection();
      const slabPubkey = new PublicKey(slab);
      const data = await fetchSlab(connection, slabPubkey);
      const header = parseHeader(data);
      const cfg = parseConfig(data);
      const engine = parseEngine(data);

      return c.json({
        slabAddress: slab,
        header: {
          magic: header.magic.toString(),
          version: header.version,
          admin: header.admin.toBase58(),
          resolved: header.resolved,
        },
        config: {
          collateralMint: cfg.collateralMint.toBase58(),
          vault: cfg.vaultPubkey.toBase58(),
          oracleAuthority: cfg.oracleAuthority.toBase58(),
          authorityPriceE6: cfg.authorityPriceE6.toString(),
        },
        engine: {
          vault: engine.vault.toString(),
          totalOpenInterest: engine.totalOpenInterest.toString(),
          numUsedAccounts: engine.numUsedAccounts,
          lastCrankSlot: engine.lastCrankSlot.toString(),
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Unknown error";
      logger.error("Market fetch error", { detail, path: c.req.path });
      return c.json({ error: "Failed to fetch market data" }, 400);
    }
  });

  return app;
}
