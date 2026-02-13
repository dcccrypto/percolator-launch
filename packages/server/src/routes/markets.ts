import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { validateSlab } from "../middleware/validateSlab.js";
import { requireApiKey } from "../middleware/auth.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine, SLAB_TIERS, type SlabTierKey } from "@percolator/core";
import { getConnection } from "../utils/solana.js";
import { config } from "../config.js";
import { getSupabase } from "../db/client.js";
import type { CrankService } from "../services/crank.js";
import type { MarketLifecycleManager, LaunchOptions } from "../services/lifecycle.js";

interface MarketDeps {
  crankService: CrankService;
  lifecycleManager: MarketLifecycleManager;
}

export function marketRoutes(deps: MarketDeps): Hono {
  const app = new Hono();

  // GET /markets — list all discovered markets with full on-chain data
  app.get("/markets", (c) => {
    const markets = deps.crankService.getMarkets();
    const result = Array.from(markets.entries()).map(([key, state]) => {
      const m = state.market;
      return {
        slabAddress: key,
        programId: m.programId.toBase58(),
        admin: m.header.admin.toBase58(),
        resolved: m.header.resolved,
        mint: m.config.collateralMint.toBase58(),
        vault: m.config.vaultPubkey.toBase58(),
        oracleAuthority: m.config.oracleAuthority.toBase58(),
        indexFeedId: m.config.indexFeedId.toBase58(),
        authorityPriceE6: m.config.authorityPriceE6.toString(),
        lastEffectivePriceE6: m.config.lastEffectivePriceE6.toString(),
        totalOpenInterest: m.engine.totalOpenInterest.toString(),
        cTot: m.engine.cTot.toString(),
        insuranceFundBalance: m.engine.insuranceFund?.balance?.toString() ?? "0",
        numUsedAccounts: m.engine.numUsedAccounts,
        lastCrankSlot: m.engine.lastCrankSlot.toString(),
        initialMarginBps: m.params.initialMarginBps.toString(),
        maintenanceMarginBps: m.params.maintenanceMarginBps.toString(),
        lastCrankTime: state.lastCrankTime,
        successCount: state.successCount,
        failureCount: state.failureCount,
      };
    });
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

  // GET /markets/:slab — single market details
  app.get("/markets/:slab", validateSlab, async (c) => {
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

  // POST /markets — register an existing market (verified on-chain)
  app.post("/markets", requireApiKey(), async (c) => {
    const body = await c.req.json<{ slabAddress: string; metadata?: Record<string, unknown> }>();

    // Bug 15: Validate input
    if (!body.slabAddress || typeof body.slabAddress !== "string") {
      return c.json({ error: "Missing or invalid slabAddress" }, 400);
    }
    try {
      new PublicKey(body.slabAddress);
    } catch {
      return c.json({ error: "slabAddress is not a valid base58 PublicKey" }, 400);
    }

    // Verify slab exists on-chain and is owned by our program
    try {
      const connection = getConnection();
      const slabPubkey = new PublicKey(body.slabAddress);
      const accountInfo = await connection.getAccountInfo(slabPubkey);
      if (!accountInfo) {
        return c.json({ error: "Slab account does not exist on-chain" }, 400);
      }
      // Bug 14: Check against ALL program IDs
      const isOwnedByProgram = config.allProgramIds.some(
        (id: string) => accountInfo.owner.equals(new PublicKey(id))
      );
      if (!isOwnedByProgram) {
        return c.json({ error: "Slab account not owned by percolator program" }, 400);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("not owned")) throw err;
      return c.json({ error: "Failed to verify slab on-chain" }, 400);
    }

    const ok = await deps.lifecycleManager.registerMarket(body.slabAddress, body.metadata ?? {});
    return c.json({ registered: ok });
  });

  // POST /markets/launch — one-click launch
  // Input: { mint: string, slabTier?: "micro"|"small"|"medium"|"large", options?: LaunchOptions }
  // Returns market config for frontend tx execution, or discovered market if already created
  app.post("/markets/launch", requireApiKey(), async (c) => {
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
