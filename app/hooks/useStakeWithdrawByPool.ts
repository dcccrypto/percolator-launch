'use client';

import { useCallback, useRef, useState } from 'react';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import {
  STAKE_PROGRAM_ID,
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveDepositPda,
  encodeStakeWithdraw,
  withdrawAccounts,
} from '@percolator/sdk';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { sendTx } from '@/lib/tx';

export interface StakeWithdrawPoolParams {
  /** The slab (market) address this pool belongs to. Used for PDA derivation. */
  slabAddress: string;
  /** SPL mint for pool collateral (USDC). */
  collateralMint: string;
}

/**
 * Standalone hook for withdrawing from a stake pool by explicit pool params.
 * Unlike `useStakeWithdraw`, this does NOT depend on SlabProvider or useParams —
 * it is safe to use on the /stake overview page.
 *
 * Burns LP tokens and returns the pro-rata share of collateral from the vault.
 * Subject to cooldown — will fail on-chain if cooldown hasn't elapsed.
 *
 * Usage:
 * ```tsx
 * const { withdraw, loading, error } = useStakeWithdrawByPool({
 *   slabAddress: pool.slabAddress,
 *   collateralMint: pool.collateralMint,
 * });
 * await withdraw(500_000n); // burn 0.5 LP tokens
 * ```
 */
export function useStakeWithdrawByPool({ slabAddress, collateralMint }: StakeWithdrawPoolParams) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const withdraw = useCallback(
    async (lpAmount: bigint) => {
      if (inflightRef.current) throw new Error('Stake withdrawal already in progress');
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
        if (lpAmount <= 0n) {
          throw new Error('Withdraw LP amount must be greater than zero');
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

        // Fetch pool account to get lpMint and vault
        const poolInfo = await connection.getAccountInfo(pool);
        if (!poolInfo || poolInfo.data.length < 186) {
          throw new Error('Stake pool not initialized for this market.');
        }

        const poolData = Buffer.from(poolInfo.data);
        const lpMint = new PublicKey(poolData.subarray(65, 97));
        const vault = new PublicKey(poolData.subarray(97, 129));

        // Get user's ATAs
        const userCollateralAta = await getAssociatedTokenAddress(collMintPk, wallet.publicKey);
        const userLpAta = await getAssociatedTokenAddress(lpMint, wallet.publicKey);

        const instructions: TransactionInstruction[] = [];

        // Create collateral ATA if it doesn't exist (user might have closed it)
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

        // Build stake withdraw instruction
        const data = encodeStakeWithdraw(lpAmount);
        const keys = withdrawAccounts({
          user: wallet.publicKey,
          pool,
          userLpAta,
          lpMint,
          vault,
          userCollateralAta,
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

  return { withdraw, loading, error };
}
