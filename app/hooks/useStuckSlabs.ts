"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { isV17Account } from "@percolatorct/sdk";
import {
  loadAllInFlightMarkets,
  clearInFlightMarket,
  type InFlightMarketState,
} from "@/lib/inFlightMarket";

// v17: isV17Account() from SDK handles magic detection for both v17 and v12 slabs.
// PERCOLAT_MAGIC (v12) is no longer checked directly here.

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
  /** Last completed step from the in-flight save (0..6 — see inFlightMarket.ts) */
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
 * Only returns stuck-slab records whose persisted adminAddress matches the
 * currently-connected wallet. That prevents the banner from showing entries
 * from other wallets and naturally handles two-tab races.
 *
 * W7 fix (2026-07-08): this used to surface ONLY the single most-recently
 * touched in-flight market (loadLastInFlightMarket). If a user abandoned
 * market A, then hit trouble again on market B, market A's stuck slab (and
 * its locked rent) became permanently invisible to the recovery banner —
 * `lib/inFlightMarket.ts`'s POINTER_KEY only ever points at the last one
 * touched. `stuckSlabs` below now resolves EVERY persisted in-flight entry
 * for the connected wallet (`loadAllInFlightMarkets`), so RecoverSolBanner
 * can render one card per stuck market. `stuckSlab` (singular) is kept as
 * the most-recently-created entry for backward compatibility with existing
 * callers (e.g. CreateMarketWizard's own restoreSlabKeypair wiring).
 */
export function useStuckSlabs() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [stuckSlabs, setStuckSlabs] = useState<StuckSlab[]>([]);
  const [loading, setLoading] = useState(true);
  // Guards against wallet A's Promise.all landing after wallet B's and
  // stomping it — bumped on every `check()` invocation; a resolved run only
  // applies its result if it's still the most recent one requested.
  const requestIdRef = useRef(0);

  const resolveOne = useCallback(
    async (inFlight: InFlightMarketState): Promise<StuckSlab> => {
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
        return {
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
        };
      }

      // Account exists — check if market was initialized via v17 magic (or v12 PERCOLAT magic).
      // isV17Account() checks the v17 magic bytes at offset 0; also detect v12 via PERCOLAT magic fallback.
      const PERCOLAT_MAGIC_V12 = 0x504552434f4c4154n; // "PERCOLAT" as u64 LE
      const data = new Uint8Array(accountInfo.data);
      const isV17 = isV17Account(data);
      const isV12 = accountInfo.data.length >= 8 &&
        new DataView(
          accountInfo.data.buffer,
          accountInfo.data.byteOffset,
          accountInfo.data.byteLength,
        ).getBigUint64(0, true) === PERCOLAT_MAGIC_V12;
      const isInitialized = isV17 || isV12;

      return {
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
      };
    },
    [connection],
  );

  const check = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const isCurrentRequest = () => requestIdRef.current === requestId;

    setLoading(true);
    try {
      // Wallet-match gate: only show entries that belong to the connected wallet.
      // Without this, two-tab race conditions could surface another tab's market.
      if (!wallet.publicKey) {
        if (isCurrentRequest()) setStuckSlabs([]);
        return;
      }
      const walletB58 = wallet.publicKey.toBase58();
      const all = loadAllInFlightMarkets().filter((s) => s.adminAddress === walletB58);
      if (all.length === 0) {
        if (isCurrentRequest()) setStuckSlabs([]);
        return;
      }
      // Wallet A's Promise.all can land after wallet B's own check() started
      // (and possibly already resolved) — only the most-recently-requested
      // check is allowed to apply its result.
      const resolved = await Promise.all(all.map(resolveOne));
      if (!isCurrentRequest()) return;
      // Most-recently-created first — matches the old single-banner ordering
      // (loadLastInFlightMarket always pointed at the latest touch).
      resolved.sort((a, b) => b.state.createdAt - a.state.createdAt);
      setStuckSlabs(resolved);
    } catch (err) {
      console.warn("[useStuckSlabs] Error checking stuck slabs:", err);
      // Don't clear — might be a transient RPC error. Keep the last-good
      // list on screen rather than blanking the recovery banner.
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [wallet.publicKey, resolveOne]);

  useEffect(() => {
    check();
  }, [check]);

  /**
   * Clears one in-flight entry by slab address. The no-arg form (backward
   * compatible with pre-W7 callers) clears the most-recent entry — i.e. the
   * same one `stuckSlab` (singular) below points at.
   */
  const clearStuck = useCallback(
    (slabAddress?: string) => {
      const target = slabAddress ?? stuckSlabs[0]?.publicKey.toBase58();
      if (!target) return;
      clearInFlightMarket(target);
      setStuckSlabs((prev) => prev.filter((s) => s.publicKey.toBase58() !== target));
    },
    [stuckSlabs],
  );

  return {
    /** Most-recently-created stuck slab — kept for backward compatibility. */
    stuckSlab: stuckSlabs[0] ?? null,
    /** W7: every stuck slab for the connected wallet — drives multi-banner rendering. */
    stuckSlabs,
    loading,
    clearStuck,
    refresh: check,
  };
}
