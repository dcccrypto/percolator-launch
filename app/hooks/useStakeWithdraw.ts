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
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';

/**
 * Hook for withdrawing collateral from a percolator-stake pool.
 *
 * Burns LP tokens and returns the pro-rata share of collateral from the vault.
 * Subject to cooldown — will fail on-chain if cooldown hasn't elapsed.
 *
 * Usage:
 * ```tsx
 * const { withdraw, loading, error } = useStakeWithdraw();
 * await withdraw(500_000n); // burn 0.5 LP tokens
 * ```
 */
export function useStakeWithdraw() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  const params = useParams();
  const slabAddress = params?.slab as string | undefined;

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
        if (!slabAddress || !slabState.config) {
          throw new Error('Market not loaded');
        }
        if (lpAmount <= 0n) {
          throw new Error('Withdraw LP amount must be greater than zero');
        }

        const slabPk = new PublicKey(slabAddress);

        // Validate slab exists on-chain (P-CRITICAL-3: network check)
        try {
          const slabInfo = await connection.getAccountInfo(slabPk);
          if (!slabInfo) {
            throw new Error('Market not found on current network. Please switch networks in your wallet and refresh.');
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('Market not found')) throw e;
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
        const collateralMint = slabState.config.collateralMint;
        const userCollateralAta = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);
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
              collateralMint,
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
    [connection, wallet, slabState.config, slabAddress],
  );

  return { withdraw, loading, error };
}
