import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine, SLAB_TIERS, type SlabTierKey } from "@percolator/core";
import { getConnection } from "../utils/solana.js";
import type { CrankService } from "../services/crank.js";
import type { MarketLifecycleManager, LaunchOptions } from "../services/lifecycle.js";

interface MarketDeps {
  crankService: CrankService;
  lifecycleManager: MarketLifecycleManager;
}

export function marketRoutes(deps: MarketDeps): Hono {
  const app = new Hono();

  // GET /markets — list all discovered markets with stats
  app.get("/markets", (c) => {
    const markets = deps.crankService.getMarkets();
    const result = Array.from(markets.entries()).map(([key, state]) => ({
      slabAddress: key,
      admin: state.market.header.admin.toBase58(),
      mint: state.market.config.collateralMint.toBase58(),
      lastCrankTime: state.lastCrankTime,
      successCount: state.successCount,
      failureCount: state.failureCount,
    }));
    return c.json({ markets: result });
  });

  // GET /markets/:slab — single market details
  app.get("/markets/:slab", async (c) => {
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
      return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 400);
    }
  });

  // POST /markets — register an existing market
  app.post("/markets", async (c) => {
    const body = await c.req.json<{ slabAddress: string; metadata?: Record<string, unknown> }>();
    const ok = await deps.lifecycleManager.registerMarket(body.slabAddress, body.metadata ?? {});
    return c.json({ registered: ok });
  });

  // POST /markets/launch — one-click launch
  // Input: { mint: string, slabTier?: "micro"|"small"|"medium"|"large", options?: LaunchOptions }
  // Returns market config for frontend tx execution, or discovered market if already created
  app.post("/markets/launch", async (c) => {
    const body = await c.req.json<{
      mint: string;
      slabTier?: SlabTierKey;
      options?: LaunchOptions;
    }>();

    const { mint, slabTier = "small", options = {} } = body;

    if (!mint) {
      return c.json({ error: "Missing mint address" }, 400);
    }

    // Validate mint
    try {
      new PublicKey(mint);
    } catch {
      return c.json({ error: "Invalid mint address" }, 400);
    }

    // Validate slab tier
    if (!(slabTier in SLAB_TIERS)) {
      return c.json({ error: `Invalid slabTier: ${slabTier}` }, 400);
    }

    // Try to find an existing market first
    const existing = await deps.lifecycleManager.launchMarket(mint, options);
    if (existing.market) {
      const tier = SLAB_TIERS[slabTier];
      return c.json({
        marketId: existing.market.slabAddress.toBase58(),
        slabAddress: existing.market.slabAddress.toBase58(),
        status: "live" as const,
        slabTier,
        slabDataSize: tier.dataSize,
        maxAccounts: tier.maxAccounts,
      });
    }

    // No existing market — prepare launch config
    const result = await deps.lifecycleManager.prepareLaunch(mint, slabTier);
    if (result.status === "failed") {
      return c.json({ error: "Failed to prepare launch" }, 500);
    }

    // Also detect pool info for the response
    const pool = await deps.lifecycleManager.detectDexPool(mint);

    return c.json({
      ...result,
      pool: pool ? {
        poolAddress: pool.poolAddress,
        dexId: pool.dexId,
        pairLabel: pool.pairLabel,
        liquidityUsd: pool.liquidityUsd,
        priceUsd: pool.priceUsd,
      } : null,
    });
  });

  return app;
}
