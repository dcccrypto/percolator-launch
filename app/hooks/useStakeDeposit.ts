'use client';

import { useCallback, useRef, useState } from 'react';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import {
  STAKE_PROGRAM_ID,
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveDepositPda,
  encodeStakeDeposit,
  depositAccounts,
} from '@percolator/sdk';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { sendTx } from '@/lib/tx';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';

/**
 * Hook for depositing collateral into a percolator-stake pool.
 *
 * Derives all PDAs from the slab address. Automatically creates the user's
 * LP token ATA if it doesn't exist yet.
 *
 * Usage:
 * ```tsx
 * const { deposit, loading, error } = useStakeDeposit();
 * await deposit(1_000_000n); // deposit 1 USDC (6 decimals)
 * ```
 */
export function useStakeDeposit() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  const params = useParams();
  const slabAddress = params?.slab as string | undefined;

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
        if (!slabAddress || !slabState.config) {
          throw new Error('Market not loaded');
        }
        if (amount <= 0n) {
          throw new Error('Deposit amount must be greater than zero');
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

        // Fetch pool account to get lpMint and vault addresses
        const poolInfo = await connection.getAccountInfo(pool);
        if (!poolInfo || poolInfo.data.length < 186) {
          throw new Error('Stake pool not initialized for this market. Contact admin.');
        }

        // Parse lpMint and vault from pool account (offsets from struct layout)
        const poolData = Buffer.from(poolInfo.data);
        const lpMint = new PublicKey(poolData.subarray(65, 97));   // offset 1+32+32 = 65
        const vault = new PublicKey(poolData.subarray(97, 129));    // offset 65+32 = 97

        // Get or create user's collateral ATA
        const collateralMint = slabState.config.collateralMint;
        const userCollateralAta = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);

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
              collateralMint,
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
    [connection, wallet, slabState.config, slabAddress],
  );

  return { deposit, loading, error };
}
