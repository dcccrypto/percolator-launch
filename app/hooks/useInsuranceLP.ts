'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import { PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  unpackMint,
  unpackAccount,
} from '@solana/spl-token';
import {
  deriveInsuranceLpMint,
} from '@percolator/sdk';
import { useSlabState } from '../components/providers/SlabProvider';
import { useParams } from 'next/navigation';

export interface InsuranceLPState {
  /** Insurance fund balance in base tokens (lamports) */
  insuranceBalance: bigint;
  /** Total LP token supply */
  lpSupply: bigint;
  /** User's LP token balance */
  userLpBalance: bigint;
  /** Current redemption rate (insurance_balance / lp_supply) in e6 */
  redemptionRateE6: bigint;
  /** User's share of the pool as a percentage */
  userSharePct: number;
  /** User's redeemable value in base tokens */
  userRedeemableValue: bigint;
  /** Whether insurance LP mint exists for this market */
  mintExists: boolean;
  /** The insurance LP mint address */
  lpMintAddress: PublicKey | null;
  /** Decimals of the LP token mint (NOT collateral decimals) */
  lpDecimals: number;
}

export function useInsuranceLP() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  const params = useParams();
  const slabAddress = params?.slab as string | undefined;
  const programId = slabState.programId;

  const [state, setState] = useState<InsuranceLPState>({
    insuranceBalance: 0n,
    lpSupply: 0n,
    userLpBalance: 0n,
    redemptionRateE6: 0n,
    userSharePct: 0,
    userRedeemableValue: 0n,
    mintExists: false,
    lpMintAddress: null,
    lpDecimals: 6,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stabilize wallet.publicKey reference — PublicKey is not referentially stable
  const walletPubkeyStr = wallet.publicKey?.toBase58() ?? null;

  // Derive the insurance LP mint PDA
  const lpMintInfo = useMemo(() => {
    if (!slabAddress || !programId) return null;
    try {
      const slabPubkey = new PublicKey(slabAddress);
      const progPubkey = new PublicKey(programId);
      const [mintPda, bump] = deriveInsuranceLpMint(progPubkey, slabPubkey);
      return { mintPda, bump };
    } catch {
      return null;
    }
  }, [slabAddress, programId]);

  // Poll insurance state
  const refreshState = useCallback(async () => {
    if (!slabState || !lpMintInfo || !connection) return;

    try {
      // Check if LP mint exists on-chain first — needed to sanitize insuranceBalance
      const mintInfo = await connection.getAccountInfo(lpMintInfo.mintPda);
      const mintExists = mintInfo != null && mintInfo.data != null && mintInfo.data.length > 0;

      // Get insurance balance from engine state.
      // Guard: Solana uninitialised u64 fields read as u64::MAX (2^64-1).
      // Only trust the value when the LP mint is live; otherwise clamp to 0.
      const U64_MAX = 18_446_744_073_709_551_615n;
      const rawBalance = slabState.engine?.insuranceFund?.balance ?? 0n;
      const insuranceBalance =
        mintExists && rawBalance <= U64_MAX / 2n ? rawBalance : 0n;

      let lpSupply = 0n;
      let lpDecimals = 6;
      let userLpBalance = 0n;

      if (mintExists) {
        // Read supply and decimals from LP mint
        // IMPORTANT: LP tokens have their own decimals — do NOT use collateral decimals here.
        const mint = unpackMint(lpMintInfo.mintPda, mintInfo);
        lpSupply = mint.supply;
        lpDecimals = mint.decimals;

        // Get user's LP token balance — use stabilized string to avoid re-render loops
        if (walletPubkeyStr) {
          try {
            const walletPk = new PublicKey(walletPubkeyStr);
            const userLpAta = await getAssociatedTokenAddress(
              lpMintInfo.mintPda,
              walletPk
            );
            const ataInfo = await connection.getAccountInfo(userLpAta);
            if (ataInfo) {
              const account = unpackAccount(userLpAta, ataInfo);
              userLpBalance = account.amount;
            }
          } catch {
            // ATA doesn't exist yet — user has 0 LP tokens
          }
        }
      }

      // Calculate derived values
      const redemptionRateE6 = lpSupply > 0n
        ? (insuranceBalance * 1_000_000n) / lpSupply
        : 1_000_000n; // 1:1 if no supply

      const userSharePct = lpSupply > 0n
        ? Number((userLpBalance * 10000n) / lpSupply) / 100
        : 0;

      const userRedeemableValue = lpSupply > 0n
        ? (userLpBalance * insuranceBalance) / lpSupply
        : 0n;

      setState({
        insuranceBalance,
        lpSupply,
        userLpBalance,
        redemptionRateE6,
        userSharePct,
        userRedeemableValue,
        mintExists,
        lpMintAddress: mintExists ? lpMintInfo.mintPda : null,
        lpDecimals,
      });
    } catch (err) {
      console.error('Failed to refresh insurance LP state:', err);
    }
  }, [slabState, lpMintInfo, connection, walletPubkeyStr]);

  // H3: Auto-refresh every 10s — use ref to avoid stale closure
  const refreshStateRef = useRef(refreshState);
  useEffect(() => {
    refreshStateRef.current = refreshState;
  }, [refreshState]);
  
  useEffect(() => {
    // Call refreshState on mount and set up auto-refresh interval
    const doRefresh = () => refreshStateRef.current();
    doRefresh();
    const interval = setInterval(doRefresh, 10_000);
    return () => clearInterval(interval);
  }, []); // Empty deps safe now — ref always points to latest refreshState

  // Insurance LP operations moved to percolator-stake program.
  // These stubs prevent runtime crashes until the UI is updated to use the new program.
  const createMint = useCallback(async () => {
    throw new Error('Insurance LP mint creation has moved to the percolator-stake program');
  }, []);

  const deposit = useCallback(async (_amount: bigint) => {
    throw new Error('Insurance LP deposits have moved to the percolator-stake program');
  }, []);

  const withdraw = useCallback(async (_lpAmount: bigint) => {
    throw new Error('Insurance LP withdrawals have moved to the percolator-stake program');
  }, []);

  return {
    state,
    loading,
    error,
    createMint,
    deposit,
    withdraw,
    refreshState,
  };
}
