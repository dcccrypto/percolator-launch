"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { PublicKey } from "@solana/web3.js";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { getHeldNftSnapshot, makeHeldNftScanKey, subscribeHeldNftScan, type HeldNftRaw } from "@/lib/userAccountScan";

/**
 * Subscribes to the shared held-NFT store for `wallet`. The returned snapshot is referentially stable until a
 * scan publishes a CHANGED result, so including it in an effect's deps re-runs that effect when a throttled
 * trailing scan lands (triggerHeldNftScan itself resolves with the stale snapshot while throttled).
 */
export function useHeldNftSnapshot(wallet: PublicKey | null): HeldNftRaw[] | null {
  const walletStr = wallet?.toBase58() ?? null;
  const key = walletStr && wallet ? makeHeldNftScanKey(PERCOLATOR_NFT_PROGRAM_ID, wallet) : null;
  const subscribe = useCallback(
    (onStoreChange: () => void) => (key ? subscribeHeldNftScan(key, onStoreChange) : () => {}),
    [key],
  );
  const getSnapshot = useCallback(() => getHeldNftSnapshot(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
