"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { resolveLpTradeAccounts } from "@/hooks/useTrade";
import {
  decodeAssetRiskLimits,
  decodeAssetVaultLp,
  decodeMarketEngineView,
  decodeMatcherCtx,
  decodePortfolioRisk,
  signedPositionForAsset,
  type MatcherCtxView,
} from "@/lib/limits/decode";
import { effectiveExecBandBps } from "@/lib/limits/risk-limits";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import type { MatcherExtCaps } from "@/lib/limits/matcher-quote";
import { growthFor } from "@/hooks/useMarketLimits";
import { growthRecordPresence } from "@/lib/v21/growth-market";
import { matcherExtCapsFromGrowth } from "@/lib/v22/matcher-ext-caps";
import { feeChannelOf } from "@/lib/limits/fee-channel";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import { spreadEstimateFromCtx, type SpreadEstimate, type SpreadQuoteOpts } from "@/lib/v22/spread-estimate";

/**
 * M7: the pre-trade "Spread / price impact" source for the surrounding market (the trade page, or the on-demand SlabProvider the
 * portfolio close mounts). While `enabled` (a confirm or close dialog is open) it reads the market, the LP's portfolio and its matcher
 * context ONCE and returns `(sizeQ, takerBuys, takerReducing?) => estimate` for THAT order size: the charged spread grows with size (the
 * matcher's impact term runs on the wrapper's capital-derived depth, not the context's), so a quote for a small order is not the quote for a
 * large one. Null until read / when it cannot be read: callers word that as unknown, never as 0.
 */
export type SpreadQuoter = ((sizeQ: bigint, takerBuys: boolean, takerReducing?: boolean) => SpreadEstimate | null) & {
  /** True when the quote will NOT arrive (read failed, no matcher context, a ctx it cannot price, mock mode): "unavailable", not "still loading". */
  unavailable: boolean;
};

export function useSpreadQuoter(enabled: boolean, assetIndex = 0, refreshKey: number = 0): SpreadQuoter {
  const connection = useConnectionCompat()?.connection ?? null;
  const slab = useSlabState();
  const slabAddress = slab?.slabAddress;
  const programId = slab?.programId;
  const [src, setSrc] = useState<{ ctx: MatcherCtxView; oracleE6: bigint; inFee: boolean; ext: MatcherExtCaps | null; nowSlot: bigint; bandBps: number | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const mockMode = !!slabAddress && isMockMode() && isMockSlab(slabAddress);

  useEffect(() => {
    if (!enabled || mockMode || !connection || !programId || !slabAddress) return;
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        const market = new PublicKey(slabAddress);
        const lp = await resolveLpTradeAccounts(connection, programId, market);
        if (!lp.matcherCtx) { if (!cancelled) setFailed(true); return; }
        const [infos, slotNow] = await Promise.all([
          connection.getMultipleAccountsInfo([market, lp.matcherCtx, lp.accountB], "confirmed"),
          connection.getSlot("confirmed"),
        ]);
        const m = infos[0] ? new Uint8Array(infos[0].data) : null;
        const c = infos[1] ? new Uint8Array(infos[1].data) : null;
        const pf = infos[2] ? new Uint8Array(infos[2].data) : null;
        const eng = m ? decodeMarketEngineView(m, assetIndex) : null;
        const ctx0 = c ? decodeMatcherCtx(c) : null;
        if (cancelled) return;
        if (!m || !eng || !ctx0 || eng.effectivePriceE6 <= 0n) { setFailed(true); return; }
        // The wrapper tells the matcher the LP's REAL engine position on every fill and the matcher prices from it, not from its counter.
        const lpRealQ = pf ? lpEffectiveSignedQ(pf, eng, assetIndex, eng.marketId) : null;
        const ctx: MatcherCtxView = lpRealQ !== null ? { ...ctx0, inventoryBase: lpRealQ } : ctx0;
        // Growth legs carry the wrapper's ext-v3 caps. A growth asset whose caps cannot be rebuilt is UNKNOWN (never priced on the context's depth,
        // which would read the impact as ~0); an asset without a growth record has no caps.
        let ext: MatcherExtCaps | null = null;
        if (growthRecordPresence(m, assetIndex) !== "absent") {
          const risk = pf ? decodePortfolioRisk(pf) : null;
          let vaultLp = null;
          try { vaultLp = decodeAssetVaultLp(m, assetIndex); } catch { vaultLp = null; }
          const lpView = risk && pf ? { ...risk, address: lp.accountB, posQ: signedPositionForAsset(pf, assetIndex, eng.marketId) } : null;
          const view = growthFor({ engine: eng, vaultLp }, { lp: lpView }, lpRealQ, m, assetIndex, BigInt(slotNow));
          ext = matcherExtCapsFromGrowth(view, eng.effectivePriceE6);
          if (!ext) { setFailed(true); return; }
        }
        const limits = decodeAssetRiskLimits(m, assetIndex);
        setSrc({ ctx, oracleE6: eng.effectivePriceE6, inFee: feeChannelOf(limits).enabled, ext, nowSlot: BigInt(slotNow), bandBps: limits ? effectiveExecBandBps(limits.execBandBps) : null });
      } catch {
        /* unknown stays unknown, and is reported as unavailable (not loading) */
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, mockMode, connection, programId, slabAddress, assetIndex, refreshKey]);

  const unavailable = !src && (mockMode || failed);
  return useMemo(() => {
    const quote = (sizeQ: bigint, takerBuys: boolean, takerReducing = false) => {
      if (!src) return null;
      const opts: SpreadQuoteOpts = { ext: src.ext, takerReducing, nowSlot: src.nowSlot, ...(src.bandBps !== null ? { bandBps: src.bandBps } : {}) };
      return spreadEstimateFromCtx(src.ctx, src.oracleE6, sizeQ < 0n ? -sizeQ : sizeQ, takerBuys, src.inFee, opts);
    };
    return Object.assign(quote, { unavailable });
  }, [src, unavailable]);
}
