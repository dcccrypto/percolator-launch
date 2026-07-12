"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { AccountKind, isV17Account } from "@percolatorct/sdk";
import {
  makePortfolioScanKey,
  getPortfolioUserAccountSnapshot,
  subscribePortfolioScan,
  triggerPortfolioScan,
  portfolioV17ToAccount,
  type UserAccountInfo,
} from "@/lib/userAccountScan";

// Re-exported for existing/legacy call sites (e.g. useNftWrappedPosition.ts
// historically imported both from this file). The canonical definitions now
// live in lib/userAccountScan.ts, which this hook's v17 path also depends on
// for its shared scan store — keeping the definitions there (not here) avoids
// a circular import between the two modules.
export type { UserAccountInfo };
export { portfolioV17ToAccount };

// ---------------------------------------------------------------------------
// v17 portfolio magic + offsets — mirrors findV17Portfolio in useDeposit/useTrade.
// market_group_id at offset 16; mutable owner (SDK PF_OWNER_OFF) at offset 116.
// NOTE: offset 80 is provenanceOwner — IMMUTABLE, set at creation. MintPositionNft
// moves the mutable owner (116) to the escrow PDA on wrap but leaves provenance (80)
// pointing at the original wallet, so filtering on 80 would still match a wrapped
// (NFT-escrowed) portfolio and render it as a normal tradeable position.
// (The actual gPA call now lives in lib/userAccountScan.ts's shared scan store —
// see that file's header for why: this hook used to be mounted ~8x simultaneously
// on the desktop trade page, each running its own identical scan every ~10s.)
// ---------------------------------------------------------------------------

export function useUserAccount(): UserAccountInfo | null {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { accounts, raw, slabAddress, programId } = useSlabState();

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

  // v17 path: the scan key identifies this (program, slab, wallet) triple in
  // the shared store. Stabilised on primitive strings (not object identity —
  // wallet-adapter/RPC objects can be recreated across renders) so the
  // useSyncExternalStore subscribe/getSnapshot callbacks below only change
  // identity (and thus resubscribe) when the underlying identity actually
  // changes, not on every render.
  const publicKeyStr = publicKey?.toBase58() ?? null;
  const programIdStr = programId?.toBase58() ?? null;
  const scanKey = useMemo(() => {
    if (!isV17Market || !publicKey || !programId || !slabAddress) return null;
    return makePortfolioScanKey(programId, slabAddress, publicKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isV17Market, publicKeyStr, programIdStr, slabAddress]);

  // Kick off (or join) the shared scan whenever `raw` changes. This does NOT
  // await the result — the shared store notifies every subscriber via
  // useSyncExternalStore below once the (possibly-shared-with-other-hook-
  // instances) scan resolves. See lib/userAccountScan.ts for the dedup
  // mechanism (identity of `raw` across simultaneously-mounted instances).
  useEffect(() => {
    if (!scanKey || !isV17Market || !publicKey || !programId || !slabAddress || raw == null) return;
    void triggerPortfolioScan({ connection, programId, slabAddress, publicKey, raw });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey, isV17Market, publicKeyStr, programIdStr, slabAddress, raw, connection]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (scanKey ? subscribePortfolioScan(scanKey, onStoreChange) : () => {}),
    [scanKey],
  );
  const getSnapshot = useCallback(() => getPortfolioUserAccountSnapshot(scanKey), [scanKey]);
  const v17Account = useSyncExternalStore(subscribe, getSnapshot, () => null);

  return isV17Market ? v17Account : v12Account;
}
