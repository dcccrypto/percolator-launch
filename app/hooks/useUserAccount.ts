"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { AccountKind, isV17Account } from "@percolatorct/sdk";
import {
  makePortfolioScanKey,
  getPortfolioUserAccountSnapshot,
  getPortfolioListSnapshot,
  getPortfolioScanResolved,
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

/** Stable empty list so `useOwnerMarketPortfolios`'s getSnapshot / server
 *  snapshot / v12-no-account paths keep a constant reference (useSyncExternal-
 *  Store requires the snapshot identity not to change unless the data did). */
const EMPTY_USER_ACCOUNT_LIST: readonly UserAccountInfo[] = Object.freeze([]);

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

/**
 * #2560: EVERY portfolio the connected wallet owns on the current market, as
 * the mapped `Account` shape, base58-sorted — the data behind the multi-
 * portfolio positions view (isolated + cross shown as separate rows).
 *
 * Invariant that keeps the single-portfolio UI unchanged: when the wallet owns
 * exactly one portfolio this returns a one-element list whose sole entry is
 * identical to `useUserAccount()` (both resolve to the lowest-pubkey pick, and
 * the same confirmed-fill patch is mirrored into the list), so a consumer can
 * render from this list and look byte-identical to today until a second
 * portfolio actually exists.
 *
 * v12 markets have no multi-portfolio model (accounts live in the slab bitmap);
 * this returns the wallet's single v12 account as a one-element list, or empty.
 *
 * Reads the SAME shared scan store as `useUserAccount` (published from one RPC);
 * it also triggers the scan so it is self-sufficient if mounted alone.
 */
export function useOwnerMarketPortfolios(): readonly UserAccountInfo[] {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { accounts, raw, slabAddress, programId } = useSlabState();

  const isV17Market = raw != null && raw.length > 0 && isV17Account(raw);

  // v12 path: the wallet's single bitmap account (if any), as a one-element list.
  const v12List = useMemo<readonly UserAccountInfo[]>(() => {
    if (isV17Market || !publicKey) return EMPTY_USER_ACCOUNT_LIST;
    const pkStr = publicKey.toBase58();
    const found = accounts.find(
      ({ account }) => account.kind === AccountKind.User && account.owner.toBase58() === pkStr,
    );
    return found ? [{ idx: found.idx, account: found.account }] : EMPTY_USER_ACCOUNT_LIST;
  }, [publicKey, accounts, isV17Market]);

  const publicKeyStr = publicKey?.toBase58() ?? null;
  const programIdStr = programId?.toBase58() ?? null;
  const scanKey = useMemo(() => {
    if (!isV17Market || !publicKey || !programId || !slabAddress) return null;
    return makePortfolioScanKey(programId, slabAddress, publicKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isV17Market, publicKeyStr, programIdStr, slabAddress]);

  useEffect(() => {
    if (!scanKey || !isV17Market || !publicKey || !programId || !slabAddress || raw == null) return;
    void triggerPortfolioScan({ connection, programId, slabAddress, publicKey, raw });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey, isV17Market, publicKeyStr, programIdStr, slabAddress, raw, connection]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (scanKey ? subscribePortfolioScan(scanKey, onStoreChange) : () => {}),
    [scanKey],
  );
  const getSnapshot = useCallback(() => getPortfolioListSnapshot(scanKey), [scanKey]);
  const v17List = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_USER_ACCOUNT_LIST);

  return isV17Market ? v17List : v12List;
}

/**
 * GH#2707: `true` while the connected wallet's v17 portfolio scan for the
 * current market has not completed yet — i.e. while `useUserAccount()`'s
 * `null` means "not known yet" rather than "this wallet has no account".
 * Surfaces use it to render loading / "—" instead of a no-account state, and
 * to keep account-dependent actions (fund-and-trade, deposit, onboarding)
 * locked until the answer is in.
 *
 * `false` when there is nothing to scan: no wallet, no slab bytes yet, or a
 * legacy (v12) market whose account list is read synchronously from the slab.
 *
 * Read-only: it does not trigger the scan. Use it next to `useUserAccount()`
 * (which does), as every caller does — the scan is shared per
 * (program, slab, wallet) key, so both read the same store entry.
 */
export function useUserAccountScanPending(): boolean {
  const { publicKey } = useWalletCompat();
  const { raw, slabAddress, programId } = useSlabState();
  const isV17Market = raw != null && raw.length > 0 && isV17Account(raw);
  const publicKeyStr = publicKey?.toBase58() ?? null;
  const programIdStr = programId?.toBase58() ?? null;
  const scanKey = useMemo(() => {
    if (!isV17Market || !publicKey || !programId || !slabAddress) return null;
    return makePortfolioScanKey(programId, slabAddress, publicKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isV17Market, publicKeyStr, programIdStr, slabAddress]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => (scanKey ? subscribePortfolioScan(scanKey, onStoreChange) : () => {}),
    [scanKey],
  );
  const getSnapshot = useCallback(() => getPortfolioScanResolved(scanKey), [scanKey]);
  const resolved = useSyncExternalStore(subscribe, getSnapshot, () => true);
  return !resolved;
}
