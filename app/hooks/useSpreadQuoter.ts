"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { resolveLpTradeAccounts } from "@/hooks/useTrade";
import { decodeAssetRiskLimits, decodeMarketEngineView, decodeMatcherCtx, type MatcherCtxView } from "@/lib/limits/decode";
import { feeChannelOf } from "@/lib/limits/fee-channel";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import { spreadEstimateFromCtx, type SpreadEstimate } from "@/lib/v22/spread-estimate";

/**
 * M7: the pre-trade "Spread / price impact" source for the surrounding market (the trade page, or the on-demand SlabProvider the
 * portfolio close mounts). While `enabled` (a confirm or close dialog is open) it reads the market and the LP's matcher context ONCE
 * and returns `(sizeQ, takerBuys) => estimate`. Null until read / when it cannot be read: callers word that as unknown, never as 0.
 */
export type SpreadQuoter = ((sizeQ: bigint, takerBuys: boolean) => SpreadEstimate | null) & {
  /** True when the quote will NOT arrive (read failed, no matcher context, a ctx it cannot price, mock mode): "unavailable", not "still loading". */
  unavailable: boolean;
};

export function useSpreadQuoter(enabled: boolean, assetIndex = 0, refreshKey: number = 0): SpreadQuoter {
  const connection = useConnectionCompat()?.connection ?? null;
  const slab = useSlabState();
  const slabAddress = slab?.slabAddress;
  const programId = slab?.programId;
  const [src, setSrc] = useState<{ ctx: MatcherCtxView; oracleE6: bigint; inFee: boolean } | null>(null);
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
        const infos = await connection.getMultipleAccountsInfo([market, lp.matcherCtx], "confirmed");
        const m = infos[0] ? new Uint8Array(infos[0].data) : null;
        const c = infos[1] ? new Uint8Array(infos[1].data) : null;
        const eng = m ? decodeMarketEngineView(m, assetIndex) : null;
        const ctx = c ? decodeMatcherCtx(c) : null;
        if (cancelled) return;
        if (eng && ctx && eng.effectivePriceE6 > 0n) setSrc({ ctx, oracleE6: eng.effectivePriceE6, inFee: feeChannelOf(m ? decodeAssetRiskLimits(m, assetIndex) : null).enabled });
        else setFailed(true);
      } catch {
        /* unknown stays unknown, and is reported as unavailable (not loading) */
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, mockMode, connection, programId, slabAddress, assetIndex, refreshKey]);

  const unavailable = !src && (mockMode || failed);
  return useMemo(() => {
    const quote = (sizeQ: bigint, takerBuys: boolean) => (src ? spreadEstimateFromCtx(src.ctx, src.oracleE6, sizeQ < 0n ? -sizeQ : sizeQ, takerBuys, src.inFee) : null);
    return Object.assign(quote, { unavailable });
  }, [src, unavailable]);
}
