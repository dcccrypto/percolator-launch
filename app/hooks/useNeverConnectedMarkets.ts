"use client";

/**
 * The connected wallet's own v2.2 markets that look never-connected, found on chain (no registry row needed, #3637).
 * One lookup per wallet (lib/v22/creator-onchain.ts); the panel then reads each market live through its own SlabProvider, so
 * the countdown and the Settle button follow the chain. Nothing is sent from here.
 */
import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { getConfig } from "@/lib/config";
import { lookupCreatorMarkets } from "@/lib/v22/creator-onchain";
import { priceNeverAdvanced } from "@/lib/v22/never-connected";

export interface CreatorOnChainMarket {
  slab: string;
  creationSlot: bigint | null;
  /** true / false from the transaction at last_good_oracle_slot; null = not readable. */
  neverPushed: boolean | null;
}

export interface NeverConnectedMarketsState {
  markets: CreatorOnChainMarket[];
  loading: boolean;
  /** A failed lookup is shown as "could not check", never as "none". */
  error: boolean;
  refetch: () => void;
}

/**
 * `isRefused` (#3676 keeper-register-client `isRegistrationRefused`, optional, must be a stable function): slabs whose live-price registration was refused for good. They are kept even when the
 * history could not be read, so the panel can still explain them (it then also requires the price to be stale today). Every other
 * market is kept only when the chain shows no price was ever pushed (or, history unreadable, the slack fallback), so healthy
 * markets never open a live subscription here. Scanned once per wallet and on `refetch`; a market younger than the launch wait
 * shows up on the next visit or refresh.
 */
export function useNeverConnectedMarkets(isRefused?: (slab: string) => boolean): NeverConnectedMarketsState {
  const { connection } = useConnectionCompat();
  const { publicKey } = useWalletCompat();
  const wallet = publicKey?.toBase58() ?? null;
  const [state, setState] = useState<{ key: string | null; markets: CreatorOnChainMarket[]; loading: boolean; error: boolean }>({ key: null, markets: [], loading: false, error: false });
  const [generation, setGeneration] = useState(0);
  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (!wallet) {
      setState({ key: null, markets: [], loading: false, error: false });
      return;
    }
    const key = `${wallet}:${generation}`;
    let cancelled = false;
    setState((s) => ({ key, markets: s.key?.startsWith(`${wallet}:`) ? s.markets : [], loading: true, error: false }));
    (async () => {
      try {
        const found = await lookupCreatorMarkets(connection, new PublicKey(getConfig().programId), new PublicKey(wallet));
        if (!cancelled) setState({ key, markets: found
              .filter(
                (f) =>
                  isRefused?.(f.slab.toBase58()) === true ||
                  f.neverPushed === true ||
                  (f.neverPushed === null && f.creationSlot !== null && priceNeverAdvanced(f.lastGoodOracleSlot, f.creationSlot)),
              )
              .map((f) => ({ slab: f.slab.toBase58(), creationSlot: f.creationSlot, neverPushed: f.neverPushed })), loading: false, error: false });
      } catch {
        if (!cancelled) setState({ key, markets: [], loading: false, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, wallet, generation, isRefused]);

  return { markets: state.markets, loading: state.loading, error: state.error, refetch };
}
