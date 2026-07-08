"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { AccountKind, isV17Account, parsePortfolioV17, type Account } from "@percolatorct/sdk";

export interface UserAccountInfo {
  idx: number;
  account: Account;
}

// ---------------------------------------------------------------------------
// v17 portfolio magic + offsets — mirrors findV17Portfolio in useDeposit/useTrade.
// market_group_id at offset 16; mutable owner (SDK PF_OWNER_OFF) at offset 116.
// NOTE: offset 80 is provenanceOwner — IMMUTABLE, set at creation. MintPositionNft
// moves the mutable owner (116) to the escrow PDA on wrap but leaves provenance (80)
// pointing at the original wallet, so filtering on 80 would still match a wrapped
// (NFT-escrowed) portfolio and render it as a normal tradeable position.
// ---------------------------------------------------------------------------
const V17_PORTFOLIO_MAGIC_UA = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const V17_PF_MARKET_OFF_UA = 16;
const V17_PF_OWNER_OFF_UA = 116;

/**
 * Map a parsed v17 portfolio to the legacy Account shape consumed by TradeForm,
 * DepositWithdrawCard, useClosePosition, useAutoDeposit, and usePortfolio.
 *
 * Mapping:
 *   capital       → portfolio.capital
 *   positionSize  → legs[0].basisPosQ if legs[0].active, else 0n
 *   entryPrice    → 0n (not stored in v17, same as v12.17)
 *   pnl           → portfolio.pnl
 *   kind          → AccountKind.User
 *   owner         → portfolio.owner
 *   matcherProgram/matcherContext → PublicKey.default (not needed for taker path)
 *   feeCredits    → portfolio.feeCredits
 *   All other v12 fields → safe zero defaults
 */
export function portfolioV17ToAccount(
  portfolio: ReturnType<typeof parsePortfolioV17>,
): Account {
  const ZERO_PK = new PublicKey(new Uint8Array(32));
  const activeLeg = portfolio.legs.find((l) => l.active);
  return {
    kind: AccountKind.User,
    accountId: 0n,
    capital: portfolio.capital,
    pnl: portfolio.pnl,
    reservedPnl: portfolio.reservedPnl,
    warmupStartedAtSlot: 0n,
    warmupSlopePerStep: 0n,
    positionSize: activeLeg ? activeLeg.basisPosQ : 0n,
    entryPrice: 0n,
    fundingIndex: 0n,
    matcherProgram: ZERO_PK,
    matcherContext: ZERO_PK,
    owner: portfolio.owner,
    feeCredits: portfolio.feeCredits,
    lastFeeSlot: portfolio.lastFeeSlot,
    feesEarnedTotal: 0n,
    exactReserveCohorts: null,
    exactCohortCount: null,
    overflowOlder: null,
    overflowOlderPresent: null,
    overflowNewest: null,
    overflowNewestPresent: null,
    fSnap: 0n,
    adlABasis: 0n,
    adlKSnap: 0n,
    adlEpochSnap: 0n,
    schedPresent: null,
    schedRemainingQ: null,
    schedAnchorQ: null,
    schedStartSlot: null,
    schedHorizon: null,
    schedReleaseQ: null,
    pendingPresent: null,
    pendingRemainingQ: null,
    pendingHorizon: null,
    pendingCreatedSlot: null,
  } as Account;
}

export function useUserAccount(): UserAccountInfo | null {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { accounts, raw, slabAddress, programId } = useSlabState();

  // v17 path: async state for the user's standalone portfolio account.
  const [v17Account, setV17Account] = useState<UserAccountInfo | null>(null);

  const isV17Market = raw != null && raw.length > 0 && isV17Account(raw);

  // v12 path: synchronous lookup in the slab bitmap accounts list.
  const v12Account = useMemo<UserAccountInfo | null>(() => {
    if (isV17Market) return null; // handled by v17 path below
    if (!publicKey) return null;
    const pkStr = publicKey.toBase58();
    const found = accounts.find(
      ({ account }) => account.kind === AccountKind.User && account.owner.toBase58() === pkStr,
    );
    return found ? { idx: found.idx, account: found.account } : null;
  }, [publicKey, accounts, isV17Market]);

  // v17 path: scan getProgramAccounts for the user's standalone portfolio.
  // Re-runs when wallet, market, or raw slab changes (raw changing indicates a
  // refreshSlab() call after deposit/trade, which triggers a re-scan).
  useEffect(() => {
    if (!isV17Market) {
      setV17Account(null);
      return;
    }
    if (!publicKey || !programId || !slabAddress) {
      setV17Account(null);
      return;
    }

    let cancelled = false;
    const slabPk = (() => {
      try { return new PublicKey(slabAddress); } catch { return null; }
    })();
    if (!slabPk) { setV17Account(null); return; }

    async function scan() {
      try {
        const results = await connection.getProgramAccounts(programId!, {
          filters: [
            { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_UA.toString("base64"), encoding: "base64" } },
            { memcmp: { offset: V17_PF_MARKET_OFF_UA, bytes: slabPk!.toBase58() } },
            { memcmp: { offset: V17_PF_OWNER_OFF_UA, bytes: publicKey!.toBase58() } },
          ],
        });
        if (cancelled) return;
        if (results.length === 0) {
          setV17Account(null);
          return;
        }
        // M10: getProgramAccounts doesn't guarantee stable ordering across RPC
        // nodes/calls. If more than one account ever matches this owner+market
        // filter, picking an arbitrary array element can select a DIFFERENT
        // portfolio than useDeposit.ts / useWithdraw.ts pick for the exact same
        // wallet+market — the displayed account could silently disagree with
        // the one deposit/withdraw actually mutate. Sort deterministically by
        // pubkey so every caller converges on the same account.
        const sorted = [...results].sort((a, b) => a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()));
        const data = sorted[0].account.data;
        const portfolio = parsePortfolioV17(data instanceof Buffer ? data : Buffer.from(data));
        // Defense-in-depth: re-verify the mutable owner actually matches after fetch —
        // memcmp filters are advisory server-side; don't trust them blindly.
        if (!portfolio.owner.equals(publicKey!)) {
          setV17Account(null);
          return;
        }
        setV17Account({ idx: 0, account: portfolioV17ToAccount(portfolio) });
      } catch {
        if (!cancelled) setV17Account(null);
      }
    }

    scan();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isV17Market, publicKey?.toBase58(), programId?.toBase58(), slabAddress, raw]);

  return isV17Market ? v17Account : v12Account;
}
