import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { isBlockedSlab } from "@/lib/blocklist";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { loadMergedMarketRows } from "@/lib/market-registry";
import { readV17MaxAbsFunding } from "@/lib/v17-engine-config";
import { isWrapperAccount } from "@/lib/v22/layout";

export const dynamic = "force-dynamic";

/** One market's current funding rate, read from its slab. */
export interface FundingGlobalEntry {
  slabAddress: string;
  baseSymbol: string | null;
  rateBpsPerSlot: number;
  hourlyRatePercent: number;
  dailyRatePercent: number;
  /** false: `max_abs_funding_e9_per_slot` is 0, so the engine clamps the applied rate to 0. */
  fundingEnabled: boolean;
}

export interface FundingGlobalResponse {
  markets: FundingGlobalEntry[];
  count: number;
  /**
   * Markets whose slab has funding switched ON. Their applied per-asset rate is not decoded by
   * this app yet (same as /api/funding/:slab, which answers 404 for them), so they are counted
   * here instead of being listed with an invented rate.
   */
  ratesUnavailable: number;
  source: "on-chain";
}

/** getMultipleAccountsInfo takes at most 100 keys per call. */
const RPC_BATCH = 100;

/**
 * GET /api/funding/global — the dashboard's Funding Rates panel.
 *
 * Was a proxy to percolator-api GET /funding/global (retired: "Application not found") with an
 * indexer fallback whose table (`funding_history`) no longer exists. Now read from the chain:
 * the market list comes from the registry (lib/market-registry, blocked slabs already dropped),
 * and each slab owned by the CURRENT wrapper is read in one batched RPC call.
 *
 *  - funding OFF (`max_abs_funding_e9_per_slot` == 0): the applied rate is exactly 0 — listed.
 *  - funding ON: the rate is not decoded here yet — counted in `ratesUnavailable`, not listed.
 *  - another program's slab / not a v17 account / missing: skipped (not a current market).
 *  - registry or RPC unavailable: 503, so the panel hides instead of claiming funding is off.
 */
export async function GET() {
  const rows = await loadMergedMarketRows().catch(() => null);
  if (rows === null) {
    return unavailable("Market list unavailable");
  }

  const symbols = new Map<string, string | null>();
  for (const row of rows) {
    const slab = typeof row.slab_address === "string" ? row.slab_address : "";
    if (!slab || isBlockedSlab(slab) || symbols.has(slab)) continue;
    let valid = true;
    try {
      new PublicKey(slab);
    } catch {
      valid = false;
    }
    if (!valid) continue;
    symbols.set(slab, typeof row.symbol === "string" && row.symbol ? row.symbol : null);
  }
  const slabs = [...symbols.keys()];

  const wrapper = getConfig().programId;
  const markets: FundingGlobalEntry[] = [];
  let ratesUnavailable = 0;
  try {
    const connection = getServerConnection("confirmed");
    for (let i = 0; i < slabs.length; i += RPC_BATCH) {
      const batch = slabs.slice(i, i + RPC_BATCH);
      const infos = await connection.getMultipleAccountsInfo(batch.map((s) => new PublicKey(s)));
      infos.forEach((info, j) => {
        if (!info || info.owner.toBase58() !== wrapper) return;
        const data = new Uint8Array(info.data);
        if (!isWrapperAccount(data)) return;
        if (readV17MaxAbsFunding(data) !== 0n) {
          ratesUnavailable += 1;
          return;
        }
        const slabAddress = batch[j];
        markets.push({
          slabAddress,
          baseSymbol: symbols.get(slabAddress) ?? null,
          rateBpsPerSlot: 0,
          hourlyRatePercent: 0,
          dailyRatePercent: 0,
          fundingEnabled: false,
        });
      });
    }
  } catch {
    return unavailable("Could not read the markets right now");
  }

  const body: FundingGlobalResponse = { markets, count: markets.length, ratesUnavailable, source: "on-chain" };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
  });
}

function unavailable(error: string): NextResponse {
  return NextResponse.json(
    { error },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "10" } },
  );
}
