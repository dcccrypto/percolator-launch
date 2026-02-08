import { PublicKey } from "@solana/web3.js";
import { discoverMarkets, SLAB_TIERS, type SlabTierKey, type DiscoveredMarket } from "@percolator/core";
import { config } from "../config.js";
import { getConnection } from "../utils/solana.js";
import { eventBus } from "./events.js";
import { CrankService } from "./crank.js";
import { OracleService } from "./oracle.js";

export type MarketStatus = "creating" | "live" | "failed" | "inactive";

export interface LaunchOptions {
  oracleType?: "admin" | "pyth" | "dex";
  metadata?: Record<string, unknown>;
}

export interface LaunchResult {
  marketId: string;
  slabAddress: string;
  status: MarketStatus;
  slabTier?: SlabTierKey;
  slabDataSize?: number;
  maxAccounts?: number;
}

const SUPPORTED_DEX_IDS = new Set(["pumpswap", "raydium", "meteora"]);

export interface DexPoolDetection {
  poolAddress: string;
  dexId: string;
  pairLabel: string;
  liquidityUsd: number;
  priceUsd: number;
}

export class MarketLifecycleManager {
  private readonly crankService: CrankService;
  private readonly oracleService: OracleService;

  constructor(crankService: CrankService, oracleService: OracleService) {
    this.crankService = crankService;
    this.oracleService = oracleService;
  }

  /**
   * Auto-detect the best DEX pool for a token mint via DexScreener.
   * Priority: PumpSwap → Raydium CLMM → Meteora DLMM, sorted by liquidity.
   */
  async detectDexPool(mint: string): Promise<DexPoolDetection | null> {
    try {
      const resp = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { headers: { "User-Agent": "percolator-server/1.0" } },
      );
      const data = await resp.json();
      const pairs = data.pairs || [];

      const candidates: DexPoolDetection[] = [];
      for (const pair of pairs) {
        if (pair.chainId !== "solana") continue;
        const dexId = (pair.dexId || "").toLowerCase();
        if (!SUPPORTED_DEX_IDS.has(dexId)) continue;
        const liquidity = pair.liquidity?.usd || 0;
        if (liquidity < 100) continue;

        candidates.push({
          poolAddress: pair.pairAddress,
          dexId,
          pairLabel: `${pair.baseToken?.symbol || "?"} / ${pair.quoteToken?.symbol || "?"}`,
          liquidityUsd: liquidity,
          priceUsd: parseFloat(pair.priceUsd) || 0,
        });
      }

      // Sort by liquidity descending
      candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
      return candidates.length > 0 ? candidates[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * POST /api/markets/launch handler logic.
   *
   * Detects pool, calculates slab size, returns config for frontend tx execution.
   */
  async prepareLaunch(
    mint: string,
    slabTier: SlabTierKey = "small",
  ): Promise<LaunchResult> {
    // Validate inputs
    let mintPk: PublicKey;
    try {
      mintPk = new PublicKey(mint);
    } catch {
      return { marketId: "", slabAddress: "", status: "failed" };
    }

    if (!(slabTier in SLAB_TIERS)) {
      return { marketId: "", slabAddress: "", status: "failed" };
    }

    const tier = SLAB_TIERS[slabTier];

    // Detect DEX pool
    const pool = await this.detectDexPool(mint);

    // Generate a placeholder market ID (actual slab address comes from frontend tx)
    const marketId = `pending-${mint.slice(0, 8)}-${Date.now()}`;

    eventBus.publish("market.creating", marketId, {
      mint,
      slabTier,
      pool: pool ? { address: pool.poolAddress, dex: pool.dexId } : null,
    });

    return {
      marketId,
      slabAddress: "", // Frontend will create the slab account
      status: "creating",
      slabTier,
      slabDataSize: tier.dataSize,
      maxAccounts: tier.maxAccounts,
    };
  }

  /**
   * Full launch flow: detect pool → discover market → register → start services.
   * For already-initialized markets (post-frontend tx execution).
   */
  async launchMarket(
    mint: string,
    options: LaunchOptions = {},
  ): Promise<{ market: DiscoveredMarket | null; registered: boolean }> {
    const connection = getConnection();
    const programId = new PublicKey(config.programId);

    // Discover all markets and find the one matching this mint
    const markets = await discoverMarkets(connection, programId);
    const mintPubkey = new PublicKey(mint);
    const found = markets.find((m) => m.config.collateralMint.equals(mintPubkey));

    if (!found) {
      return { market: null, registered: false };
    }

    const slabAddress = found.slabAddress.toBase58();

    eventBus.publish("market.created", slabAddress, {
      mint,
      oracleType: options.oracleType ?? "admin",
      metadata: options.metadata,
    });

    // Re-discover to update crank service state
    await this.crankService.discover();

    return { market: found, registered: true };
  }

  /**
   * Register an existing market by slab address.
   */
  async registerMarket(
    slabAddress: string,
    metadata: Record<string, unknown> = {},
  ): Promise<boolean> {
    eventBus.publish("market.created", slabAddress, { metadata });
    await this.crankService.discover();
    return true;
  }

  /**
   * Deregister a market — stop services, mark inactive.
   */
  deregisterMarket(slabAddress: string): void {
    eventBus.publish("market.updated", slabAddress, { status: "inactive" });
  }
}
