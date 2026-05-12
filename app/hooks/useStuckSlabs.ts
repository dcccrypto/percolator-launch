"use client";

import { useEffect, useState, useCallback } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import {
  loadLastInFlightMarket,
  clearInFlightMarket,
  type InFlightMarketState,
} from "@/lib/inFlightMarket";

/** Magic bytes at offset 0 of an initialized Percolator slab */
const PERCOLAT_MAGIC = 0x504552434f4c4154n; // "PERCOLAT" as u64 LE

export interface StuckSlab {
  /** The slab account public key */
  publicKey: PublicKey;
  /** Whether the market was successfully initialized (PERCOLAT magic found) */
  isInitialized: boolean;
  /** Whether the on-chain account exists at all */
  exists: boolean;
  /** Slab keypair, reconstructed from the persisted secret. Used by the
   *  ReclaimSlabRent (tag 52) path on uninitialised slabs. */
  keypair: Keypair | null;
  /** Lamports held by the account (rent) */
  lamports: number;
  /** The program that owns the account */
  owner: string | null;
  /** Last completed step from the in-flight save (0..4) */
  lastStep: number;
  /** Admin pubkey (for wallet-match check) */
  adminAddress: string;
  /** Collateral ATA pubkey (surfaced for the recovery script) */
  collateralAta: string;
  /** Full in-flight state for export-to-recovery JSON */
  state: InFlightMarketState;
}

/**
 * Detects in-flight markets that didn't complete (e.g. tab closed mid-flow).
 *
 * Reads the persisted in-flight state written by useCreateMarket via
 * lib/inFlightMarket.ts (NEVER stores the slab secret key — recovery uses
 * the admin keypair the user already has on disk and runs
 * scripts/close-market-reclaim-all.ts).
 *
 * Only returns a stuck-slab record if the persisted entry's adminAddress
 * matches the currently-connected wallet. That prevents the banner from
 * showing entries from other wallets and naturally handles two-tab races.
 */
export function useStuckSlabs() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [stuckSlab, setStuckSlab] = useState<StuckSlab | null>(null);
  const [loading, setLoading] = useState(true);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      const inFlight = loadLastInFlightMarket();
      if (!inFlight) {
        setStuckSlab(null);
        return;
      }

      // Wallet-match gate: only show entries that belong to the connected wallet.
      // Without this, two-tab race conditions could surface another tab's market.
      if (!wallet.publicKey || wallet.publicKey.toBase58() !== inFlight.adminAddress) {
        setStuckSlab(null);
        return;
      }

      const slabPk = new PublicKey(inFlight.slabAddress);

      // Reconstruct the keypair from the persisted secret. Falls back to
      // null if the entry is malformed (older entries before the secret
      // was added).
      let keypair: Keypair | null = null;
      try {
        if (inFlight.slabSecretKey && inFlight.slabSecretKey.length === 64) {
          keypair = Keypair.fromSecretKey(Uint8Array.from(inFlight.slabSecretKey));
        }
      } catch {
        keypair = null;
      }

      const accountInfo = await connection.getAccountInfo(slabPk);

      if (!accountInfo) {
        // Account doesn't exist — the atomic TX0 rolled back or was never sent.
        // Surface a "didn't land" record so the banner can offer to clear stale state.
        setStuckSlab({
          publicKey: slabPk,
          isInitialized: false,
          exists: false,
          keypair,
          lamports: 0,
          owner: null,
          lastStep: inFlight.lastStep,
          adminAddress: inFlight.adminAddress,
          collateralAta: inFlight.collateralAta,
          state: inFlight,
        });
        return;
      }

      // Account exists — check if market was initialized via PERCOLAT magic.
      const isInitialized =
        accountInfo.data.length >= 8 &&
        new DataView(
          accountInfo.data.buffer,
          accountInfo.data.byteOffset,
          accountInfo.data.byteLength,
        ).getBigUint64(0, true) === PERCOLAT_MAGIC;

      setStuckSlab({
        publicKey: slabPk,
        isInitialized,
        exists: true,
        keypair,
        lamports: accountInfo.lamports,
        owner: accountInfo.owner.toBase58(),
        lastStep: inFlight.lastStep,
        adminAddress: inFlight.adminAddress,
        collateralAta: inFlight.collateralAta,
        state: inFlight,
      });
    } catch (err) {
      console.warn("[useStuckSlabs] Error checking stuck slab:", err);
      // Don't clear — might be a transient RPC error
      setStuckSlab(null);
    } finally {
      setLoading(false);
    }
  }, [connection, wallet.publicKey]);

  useEffect(() => {
    check();
  }, [check]);

  const clearStuck = useCallback(() => {
    if (stuckSlab) {
      clearInFlightMarket(stuckSlab.publicKey.toBase58());
    }
    setStuckSlab(null);
  }, [stuckSlab]);

  return { stuckSlab, loading, clearStuck, refresh: check };
}
