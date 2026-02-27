"use client";

import { useEffect, useState, useCallback } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";

/** Magic bytes at offset 0 of an initialized Percolator slab */
const PERCOLAT_MAGIC = 0x504552434f4c4154n; // "PERCOLAT" as u64 LE

export interface StuckSlab {
  /** The slab account public key */
  publicKey: PublicKey;
  /** Whether the market was successfully initialized (PERCOLAT magic found) */
  isInitialized: boolean;
  /** Whether the on-chain account exists at all */
  exists: boolean;
  /** The keypair (if available — needed for recovery) */
  keypair: Keypair | null;
  /** Lamports held by the account (rent) */
  lamports: number;
  /** The program that owns the account */
  owner: string | null;
}

const STORAGE_KEY = "percolator-pending-slab-keypair";

/**
 * Detects stuck slab accounts from localStorage.
 *
 * With the atomic market creation flow (Part 1), stuck slabs are rare:
 * - createAccount + InitMarket are in a single tx, so rollback is atomic.
 * - Stuck state only occurs if the tx landed but client didn't get confirmation
 *   (network timeout during confirmTransaction).
 *
 * Returns:
 * - `stuckSlab`: info about the pending slab, or null if none found
 * - `loading`: true while checking on-chain state
 * - `clearStuck`: removes the pending keypair from localStorage
 * - `refresh`: re-check on-chain state
 */
export function useStuckSlabs() {
  const { connection } = useConnectionCompat();
  const [stuckSlab, setStuckSlab] = useState<StuckSlab | null>(null);
  const [loading, setLoading] = useState(true);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      const persisted = localStorage.getItem(STORAGE_KEY);
      if (!persisted) {
        setStuckSlab(null);
        return;
      }

      let keypair: Keypair;
      try {
        const secretKey = Uint8Array.from(JSON.parse(persisted));
        keypair = Keypair.fromSecretKey(secretKey);
      } catch {
        // Corrupted data — clean up
        localStorage.removeItem(STORAGE_KEY);
        setStuckSlab(null);
        return;
      }

      // Check if the account exists on-chain
      const accountInfo = await connection.getAccountInfo(keypair.publicKey);

      if (!accountInfo) {
        // Account doesn't exist — the atomic tx rolled back or was never sent.
        // Clean up localStorage automatically.
        setStuckSlab({
          publicKey: keypair.publicKey,
          isInitialized: false,
          exists: false,
          keypair,
          lamports: 0,
          owner: null,
        });
        return;
      }

      // Account exists — check if market was initialized
      const isInitialized =
        accountInfo.data.length >= 8 &&
        accountInfo.data.readBigUInt64LE(0) === PERCOLAT_MAGIC;

      setStuckSlab({
        publicKey: keypair.publicKey,
        isInitialized,
        exists: true,
        keypair,
        lamports: accountInfo.lamports,
        owner: accountInfo.owner.toBase58(),
      });
    } catch (err) {
      console.warn("[useStuckSlabs] Error checking stuck slab:", err);
      // Don't clear — might be a transient RPC error
      setStuckSlab(null);
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    check();
  }, [check]);

  const clearStuck = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setStuckSlab(null);
  }, []);

  return { stuckSlab, loading, clearStuck, refresh: check };
}
