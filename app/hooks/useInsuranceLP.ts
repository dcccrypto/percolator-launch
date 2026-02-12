'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import {
  encodeCreateInsuranceMint,
  encodeDepositInsuranceLP,
  encodeWithdrawInsuranceLP,
  deriveVaultAuthority,
  deriveInsuranceLpMint,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_CREATE_INSURANCE_MINT,
  ACCOUNTS_DEPOSIT_INSURANCE_LP,
  ACCOUNTS_WITHDRAW_INSURANCE_LP,
} from '@percolator/core';
import { sendTx } from '../lib/tx';
import { useSlabState, type SlabState } from '../components/providers/SlabProvider';
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
}

export function useInsuranceLP() {
  const { connection } = useConnection();
  const wallet = useWallet();
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
      // Get insurance balance from engine state
      const insuranceBalance = slabState.engine?.insuranceFund?.balance ?? 0n;

      // Check if LP mint exists on-chain
      const mintInfo = await connection.getAccountInfo(lpMintInfo.mintPda);
      const mintExists = mintInfo !== null && mintInfo.data.length > 0;

      let lpSupply = 0n;
      let userLpBalance = 0n;

      if (mintExists) {
        // Read supply from mint
        const { unpackMint } = await import('@solana/spl-token');
        const mint = unpackMint(lpMintInfo.mintPda, mintInfo);
        lpSupply = mint.supply;

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
              const { unpackAccount } = await import('@solana/spl-token');
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
      });
    } catch (err) {
      console.error('Failed to refresh insurance LP state:', err);
    }
  }, [slabState, lpMintInfo, connection, walletPubkeyStr]);

  // H3: Auto-refresh every 10s — use ref to prevent infinite loop
  useEffect(() => {
    refreshState();
    const interval = setInterval(() => {
      refreshState();
    }, 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps — refreshState captured at mount

  // Create insurance mint (admin only)
  const createMint = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signTransaction || !slabAddress || !programId || !lpMintInfo || !slabState) {
      throw new Error('Wallet not connected or slab not loaded');
    }

    setLoading(true);
    setError(null);
    try {
      const slabPubkey = new PublicKey(slabAddress);
      const progPubkey = new PublicKey(programId);
      const [vaultAuth] = deriveVaultAuthority(progPubkey, slabPubkey);
      const collateralMint = slabState.config!.collateralMint;

      const data = encodeCreateInsuranceMint();
      const keys = buildAccountMetas(ACCOUNTS_CREATE_INSURANCE_MINT, [
        wallet.publicKey,      // admin (signer)
        slabPubkey,            // slab
        lpMintInfo.mintPda,    // ins_lp_mint (writable, PDA)
        vaultAuth,             // vault_authority
        collateralMint,        // collateral_mint
        SystemProgram.programId, // system_program
        TOKEN_PROGRAM_ID,      // token_program
        SYSVAR_RENT_PUBKEY,    // rent
        wallet.publicKey,      // payer (signer, writable)
      ]);
      const ix = buildIx({ programId: progPubkey, keys, data });

      const result = await sendTx({
        connection,
        wallet,
        instructions: [ix],
      });

      await refreshState();
      return result;
    } catch (err: any) {
      setError(err.message || 'Failed to create insurance mint');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [wallet, slabAddress, programId, lpMintInfo, slabState, connection, refreshState]);

  // Deposit into insurance fund
  const deposit = useCallback(async (amount: bigint) => {
    if (!wallet.publicKey || !wallet.signTransaction || !slabAddress || !programId || !lpMintInfo || !slabState) {
      throw new Error('Wallet not connected or slab not loaded');
    }

    setLoading(true);
    setError(null);
    try {
      const slabPubkey = new PublicKey(slabAddress);
      const progPubkey = new PublicKey(programId);
      const [vaultAuth] = deriveVaultAuthority(progPubkey, slabPubkey);
      const collateralMint = slabState.config!.collateralMint;
      const vault = slabState.config!.vaultPubkey;

      // Get or create user's collateral ATA
      const userAta = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);

      // Get or create user's LP token ATA
      const userLpAta = await getAssociatedTokenAddress(lpMintInfo.mintPda, wallet.publicKey);

      const instructions: TransactionInstruction[] = [];

      // Create LP ATA if it doesn't exist
      const lpAtaInfo = await connection.getAccountInfo(userLpAta);
      if (!lpAtaInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            userLpAta,
            wallet.publicKey,
            lpMintInfo.mintPda
          )
        );
      }

      // Build deposit instruction
      const depositData = encodeDepositInsuranceLP({ amount: amount.toString() });
      const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_INSURANCE_LP, [
        wallet.publicKey,    // depositor (signer)
        slabPubkey,          // slab (writable)
        userAta,             // depositor_ata (writable)
        vault,               // vault (writable)
        TOKEN_PROGRAM_ID,    // token_program
        lpMintInfo.mintPda,  // ins_lp_mint (writable)
        userLpAta,           // depositor_lp_ata (writable)
        vaultAuth,           // vault_authority
      ]);
      instructions.push(buildIx({ programId: progPubkey, keys: depositKeys, data: depositData }));

      const result = await sendTx({
        connection,
        wallet,
        instructions,
      });

      await refreshState();
      return result;
    } catch (err: any) {
      setError(err.message || 'Failed to deposit');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [wallet, slabAddress, programId, lpMintInfo, slabState, connection, refreshState]);

  // Withdraw from insurance fund
  const withdraw = useCallback(async (lpAmount: bigint) => {
    if (!wallet.publicKey || !wallet.signTransaction || !slabAddress || !programId || !lpMintInfo || !slabState) {
      throw new Error('Wallet not connected or slab not loaded');
    }

    setLoading(true);
    setError(null);
    try {
      const slabPubkey = new PublicKey(slabAddress);
      const progPubkey = new PublicKey(programId);
      const [vaultAuth] = deriveVaultAuthority(progPubkey, slabPubkey);
      const collateralMint = slabState.config!.collateralMint;
      const vault = slabState.config!.vaultPubkey;

      const userAta = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);
      const userLpAta = await getAssociatedTokenAddress(lpMintInfo.mintPda, wallet.publicKey);

      const withdrawData = encodeWithdrawInsuranceLP({ lpAmount: lpAmount.toString() });
      const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE_LP, [
        wallet.publicKey,    // withdrawer (signer)
        slabPubkey,          // slab (writable)
        userAta,             // withdrawer_ata (writable)
        vault,               // vault (writable)
        TOKEN_PROGRAM_ID,    // token_program
        lpMintInfo.mintPda,  // ins_lp_mint (writable)
        userLpAta,           // withdrawer_lp_ata (writable)
        vaultAuth,           // vault_authority
      ]);
      const withdrawIx = buildIx({ programId: progPubkey, keys: withdrawKeys, data: withdrawData });

      const result = await sendTx({
        connection,
        wallet,
        instructions: [withdrawIx],
      });

      await refreshState();
      return result;
    } catch (err: any) {
      setError(err.message || 'Failed to withdraw');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [wallet, slabAddress, programId, lpMintInfo, slabState, connection, refreshState]);

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
