'use client';

import { useCallback, useRef, useState } from 'react';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import {
  STAKE_PROGRAM_ID,
  STAKE_POOL_SIZE,
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveDepositPda,
  encodeStakeDeposit,
  depositAccounts,
  decodeStakePool,
} from '@percolator/sdk';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { sendTx } from '@/lib/tx';

export interface StakeDepositPoolParams {
  /** The slab (market) address this pool belongs to. Used for PDA derivation. */
  slabAddress: string;
  /** SPL mint for pool collateral (USDC). */
  collateralMint: string;
}

/**
 * Standalone hook for depositing into a stake pool by explicit pool params.
 * Unlike `useStakeDeposit`, this does NOT depend on SlabProvider or useParams —
 * it is safe to use on the /stake overview page where the user selects a pool
 * from a list rather than navigating to a per-market URL.
 *
 * Usage:
 * ```tsx
 * const { deposit, loading, error } = useStakeDepositByPool({
 *   slabAddress: pool.slabAddress,
 *   collateralMint: pool.collateralMint,
 * });
 * await deposit(1_000_000n); // 1 USDC (6 decimals)
 * ```
 */
export function useStakeDepositByPool({ slabAddress, collateralMint }: StakeDepositPoolParams) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const deposit = useCallback(
    async (amount: bigint) => {
      if (inflightRef.current) throw new Error('Stake deposit already in progress');
      inflightRef.current = true;
      setLoading(true);
      setError(null);

      try {
        if (!wallet.publicKey || !wallet.signTransaction) {
          throw new Error('Wallet not connected');
        }
        if (!slabAddress || !collateralMint) {
          throw new Error('Pool not selected');
        }
        if (amount <= 0n) {
          throw new Error('Deposit amount must be greater than zero');
        }

        const slabPk = new PublicKey(slabAddress);
        const collMintPk = new PublicKey(collateralMint);

        // Validate slab exists on-chain (P-CRITICAL-3: network check)
        // Do NOT wrap in try/catch — RPC errors must propagate to prevent silent bypass of network guard.
        const slabInfo = await connection.getAccountInfo(slabPk);
        if (!slabInfo) {
          throw new Error('Market not found on current network. Please switch networks in your wallet and refresh.');
        }

        // Derive all PDAs
        const [pool] = deriveStakePool(slabPk);
        const [vaultAuth] = deriveStakeVaultAuth(pool);
        const [depositPda] = deriveDepositPda(pool, wallet.publicKey);

        // Fetch pool account to get lpMint and vault addresses
        const poolInfo = await connection.getAccountInfo(pool);
        if (!poolInfo || poolInfo.data.length < STAKE_POOL_SIZE) {
          throw new Error('Stake pool not initialized for this market. Contact admin.');
        }

        // Defense-in-depth: validate pool account owner matches stake program.
        // The pool is a PDA so an attacker cannot substitute a malicious account,
        // but this guards against edge cases in test environments or network misconfigs.
        if (!poolInfo.owner.equals(STAKE_PROGRAM_ID)) {
          throw new Error('Stake pool account owner mismatch — possible network misconfiguration.');
        }

        // Decode pool using canonical StakePool layout from SDK (352 bytes).
        // Avoids manual byte offset arithmetic — offsets are versioned in decodeStakePool.
        const { lpMint, vault } = decodeStakePool(Buffer.from(poolInfo.data));

        // Get or create user's collateral ATA
        const userCollateralAta = await getAssociatedTokenAddress(collMintPk, wallet.publicKey);

        // Get or create user's LP ATA
        const userLpAta = await getAssociatedTokenAddress(lpMint, wallet.publicKey);

        const instructions: TransactionInstruction[] = [];

        // Create collateral ATA if needed
        const collAtaInfo = await connection.getAccountInfo(userCollateralAta);
        if (!collAtaInfo) {
          instructions.push(
            createAssociatedTokenAccountInstruction(
              wallet.publicKey,
              userCollateralAta,
              wallet.publicKey,
              collMintPk,
            ),
          );
        }

        // Create LP ATA if needed
        const lpAtaInfo = await connection.getAccountInfo(userLpAta);
        if (!lpAtaInfo) {
          instructions.push(
            createAssociatedTokenAccountInstruction(
              wallet.publicKey,
              userLpAta,
              wallet.publicKey,
              lpMint,
            ),
          );
        }

        // Build stake deposit instruction
        const data = encodeStakeDeposit(amount);
        const keys = depositAccounts({
          user: wallet.publicKey,
          pool,
          userCollateralAta,
          vault,
          lpMint,
          userLpAta,
          vaultAuth,
          depositPda,
        });

        instructions.push(
          new TransactionInstruction({
            programId: STAKE_PROGRAM_ID,
            keys,
            data,
          }),
        );

        const sig = await sendTx({ connection, wallet, instructions });
        return sig;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, slabAddress, collateralMint],
  );

  return { deposit, loading, error };
}
