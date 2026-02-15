import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { SLAB_TIERS, type SlabTierKey } from "@percolator/core";

export const dynamic = 'force-dynamic';

const SUPPORTED_DEX_IDS = new Set(["pumpswap", "raydium", "meteora"]);

interface DexPoolDetection {
  poolAddress: string;
  dexId: string;
  pairLabel: string;
  liquidityUsd: number;
  priceUsd: number;
}

interface LaunchConfig {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  slabTier: SlabTierKey;
  slabDataSize: number;
  maxAccounts: number;
  oracleFeed: string;
  initialPriceE6: string;
  tradingFeeBps: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  maxLeverage: number;
  pool: DexPoolDetection | null;
  estimatedRentSol: string;
}

/**
 * POST /api/launch
 *
 * Auto-detects DEX pool for a token mint and returns the full config
 * needed to create a market. The frontend executes the transactions
 * since we need the user's wallet to sign.
 *
 * Input: { mint: string, slabTier: "micro"|"small"|"medium"|"large" }
 * Response: LaunchConfig | { error: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { mint, slabTier = "small" } = body as { mint: string; slabTier?: SlabTierKey };

    // Validate mint
    if (!mint || typeof mint !== "string") {
      return NextResponse.json({ error: "Missing mint address" }, { status: 400 });
    }
    let mintPk: PublicKey;
    try {
      mintPk = new PublicKey(mint);
    } catch {
      return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
    }

    // Validate slab tier
    if (!(slabTier in SLAB_TIERS)) {
      return NextResponse.json({ error: `Invalid slabTier: ${slabTier}` }, { status: 400 });
    }
    const tier = SLAB_TIERS[slabTier];

    // 1. Fetch token metadata from on-chain (Metaplex)
    let name = `Token ${mint.slice(0, 6)}`;
    let symbol = mint.slice(0, 4).toUpperCase();
    let decimals = 6;

    const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL
      ?? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? ""}`;

    try {
      // Get decimals from RPC
      const rpcResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [mint, { encoding: "jsonParsed" }],
        }),
      });
      const rpcData = await rpcResp.json();
      const parsed = rpcData?.result?.value?.data?.parsed;
      if (parsed?.type === "mint") {
        decimals = parsed.info.decimals;
      }
    } catch {
      // Use default decimals
    }

    // Try to get token name/symbol from Metaplex metadata
    try {
      const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
        TOKEN_METADATA_PROGRAM_ID
      );
      
      const metaResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "getAccountInfo",
          params: [metadataPDA.toBase58(), { encoding: "base64" }],
        }),
      });
      const metaData = await metaResp.json();
      
      if (metaData?.result?.value?.data?.[0]) {
        const data = Buffer.from(metaData.result.value.data[0], "base64");
        const MAX_NAME_LEN = 256;
        const MAX_SYM_LEN = 32;
        
        if (data.length >= 69) {
          const nameLen = data.readUInt32LE(65);
          if (nameLen <= MAX_NAME_LEN && data.length >= 69 + nameLen) {
            const nameRaw = data.slice(69, 69 + nameLen).toString("utf8").replace(/\0/g, "").trim();
            const symOffset = 69 + nameLen;
            
            if (data.length >= symOffset + 4) {
              const symLen = data.readUInt32LE(symOffset);
              if (symLen <= MAX_SYM_LEN && data.length >= symOffset + 4 + symLen) {
                const symRaw = data.slice(symOffset + 4, symOffset + 4 + symLen).toString("utf8").replace(/\0/g, "").trim();
                if (nameRaw && symRaw) {
                  symbol = symRaw;
                  name = nameRaw;
                }
              }
            }
          }
        }
      }
    } catch {
      // Use defaults if metadata not found
    }

    // 2. Auto-detect DEX pool via DexScreener
    let bestPool: DexPoolDetection | null = null;
    try {
      const dexResp = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { headers: { "User-Agent": "percolator-launch/1.0" } },
      );
      const dexData = await dexResp.json();
      const pairs = dexData.pairs || [];

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

      candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
      if (candidates.length > 0) {
        bestPool = candidates[0];
      }
    } catch {
      // Pool detection failed — user can still proceed with manual oracle
    }

    // 3. Derive oracle feed from pool address (pool pubkey bytes → hex)
    let oracleFeed = "0".repeat(64); // admin oracle fallback
    if (bestPool) {
      try {
        const poolPk = new PublicKey(bestPool.poolAddress);
        oracleFeed = Array.from(poolPk.toBytes())
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      } catch {
        // Fallback to admin oracle
      }
    }

    // 4. Calculate risk params based on liquidity
    const liquidity = bestPool?.liquidityUsd ?? 0;
    let tradingFeeBps: number;
    let initialMarginBps: number;

    if (liquidity < 10_000) {
      tradingFeeBps = 30;
      initialMarginBps = 2000; // 5x
    } else if (liquidity < 100_000) {
      tradingFeeBps = 20;
      initialMarginBps = 1000; // 10x
    } else {
      tradingFeeBps = 10;
      initialMarginBps = 500; // 20x
    }

    const maintenanceMarginBps = Math.floor(initialMarginBps / 2);
    const maxLeverage = Math.floor(10000 / initialMarginBps);

    // 5. Calculate price in e6
    const priceUsd = bestPool?.priceUsd ?? 0;
    const initialPriceE6 = priceUsd > 0
      ? Math.round(priceUsd * 1_000_000).toString()
      : "1000000"; // fallback: $1.00

    // 6. Estimate rent cost
    const LAMPORTS_PER_SOL = 1_000_000_000;
    const RENT_PER_BYTE_YEAR = 6960; // ~approximate
    const rentLamports = tier.dataSize * RENT_PER_BYTE_YEAR * 2; // 2 years exempt
    const estimatedRentSol = (rentLamports / LAMPORTS_PER_SOL).toFixed(2);

    const config: LaunchConfig = {
      mint,
      name,
      symbol,
      decimals,
      slabTier,
      slabDataSize: tier.dataSize,
      maxAccounts: tier.maxAccounts,
      oracleFeed,
      initialPriceE6,
      tradingFeeBps,
      initialMarginBps,
      maintenanceMarginBps,
      maxLeverage,
      pool: bestPool,
      estimatedRentSol,
    };

    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
