"use client";

import { useEffect, useRef } from "react";

/**
 * What dropping a chain resume on a wallet switch does, in this order (#3267 review):
 * abort the running create() FIRST (its closure belongs to the old wallet: left running it would ask
 * the new wallet to sign transactions built for the old one), then forget the resume, then reset the
 * launch state.
 */
export function dropChainResume(d: { cancelInFlightLaunch?: () => void; forget: () => void; resetCreate: () => void }): void {
  d.cancelInFlightLaunch?.();
  d.forget();
  d.resetCreate();
}

/**
 * Calls `drop` when the connected wallet changes while a chain resume is active. A resume verified for
 * wallet A is never carried into wallet B.
 */
export function useChainResumeWalletGuard(walletB58: string | null, active: boolean, drop: () => void): void {
  const prev = useRef(walletB58);
  const activeRef = useRef(active);
  const dropRef = useRef(drop);
  activeRef.current = active;
  dropRef.current = drop;
  useEffect(() => {
    if (prev.current !== walletB58 && activeRef.current) dropRef.current();
    prev.current = walletB58;
  }, [walletB58]);
}
