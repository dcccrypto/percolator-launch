"use client";

/**
 * Headless per-market host for the Move flow. Mounts a SlabProvider for ONE v1 market so the
 * existing, sim-gated hooks (useClosePosition, useWithdraw, useInsuranceLP) work from /move, and
 * publishes a MarketBridge for it. Renders nothing.
 */
import { useEffect, useMemo, useRef, type FC } from "react";
import { PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useWithdraw } from "@/hooks/useWithdraw";
import { useInsuranceLP } from "@/hooks/useInsuranceLP";
import { useUserAccount } from "@/hooks/useUserAccount";
import { pickOwnerPortfolio, scanOwnerPortfolios } from "@/lib/owner-portfolio";
import { decodePortfolioLegs } from "@/lib/limits/decode";
import { releasedPnlFace } from "@/lib/convert-released-pnl";
import type { MarketBridge } from "@/lib/v21/move/market-exec";
import { parsePortfolio } from "@/lib/v22/layout";

const Bridge: FC<{ slab: string; onBridge: (b: MarketBridge | null) => void }> = ({ slab, onBridge }) => {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  const userAccount = useUserAccount();
  const { closePosition } = useClosePosition(slab);
  const { withdraw } = useWithdraw(slab);
  const lp = useInsuranceLP();
  const lpRef = useRef(lp);
  lpRef.current = lp;
  const programId = slabState.programId ? new PublicKey(slabState.programId).toBase58() : null;
  const owner = wallet.publicKey;

  const bridge = useMemo<MarketBridge>(
    () => ({
      slab,
      programId,
      ready: !!programId && !slabState.loading && !!owner,
      readPortfolio: async () => {
        if (!owner || !programId) return null;
        const found = pickOwnerPortfolio(await scanOwnerPortfolios(connection, new PublicKey(programId), new PublicKey(slab), owner), owner);
        if (!found) return null;
        const pf = parsePortfolio(found.data);
        return {
          capital: BigInt(pf.capital),
          releasedPnl: releasedPnlFace(pf.pnl, pf.reservedPnl),
          openLegs: decodePortfolioLegs(found.data).length,
          userIdx: userAccount?.idx ?? 0,
        };
      },
      readEarn: async () => {
        await lpRef.current.refreshState();
        const s = lpRef.current.state;
        if (!s.mintExists && !s.hasPendingRedemption) return null;
        return { shares: s.userLpBalance, pendingShares: s.pendingRedemptionShares, cooldownElapsed: s.cooldownElapsed };
      },
      closeAll: async () => (await closePosition(100, { skipSweep: true })).signature,
      withdraw: async (a) => (await withdraw({ userIdx: a.userIdx, amount: a.amount, portfolioPk: userAccount?.pubkey })) ?? null,
      earn: async (n) => lpRef.current.withdraw(n),
    }),
    [slab, programId, slabState.loading, owner, connection, userAccount, closePosition, withdraw],
  );

  useEffect(() => {
    onBridge(bridge);
    return () => onBridge(null);
  }, [bridge, onBridge]);
  return null;
};

export const MarketExecutorHost: FC<{ slab: string; onBridge: (b: MarketBridge | null) => void }> = ({ slab, onBridge }) => (
  <SlabProvider slabAddress={slab} key={slab}>
    <Bridge slab={slab} onBridge={onBridge} />
  </SlabProvider>
);
