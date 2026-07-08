'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import {
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveDepositPda,
  encodeStakeWithdraw,
  withdrawAccounts,
} from '@percolatorct/sdk';
import { STAKE_POOL_SIZE_V1, decodeStakePoolV1 } from '@/hooks/useStakePool';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { sendTx } from '@/lib/tx';
import { getConfig } from '@/lib/config';

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

  // Reset UI state when the selected pool changes so stale loading/error
  // indicators from a previous pool don't bleed into the new pool context.
  // Do not touch inflightRef.current — the in-flight guard must stay intact
  // until the withdrawal's finally block clears it.
  useEffect(() => {
    setError(null);
    setLoading(false);
  }, [slabAddress, collateralMint]);

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

        // Stake pools are owned by this deployment's vault program (getConfig().vaultProgramId),
        // NOT the SDK's default stake program id. Derive all PDAs against the correct program.
        const stakeProgramId = new PublicKey(
          (getConfig() as { vaultProgramId?: string }).vaultProgramId
          ?? '51CeUNpbXovK2BRADPyssuf3Q1xWGabEK9pYkp5mqVhQ'
        );

        // Derive all PDAs
        const [pool] = deriveStakePool(slabPk, stakeProgramId);
        const [vaultAuth] = deriveStakeVaultAuth(pool, stakeProgramId);
        const [depositPda] = deriveDepositPda(pool, wallet.publicKey, stakeProgramId);

        // Fetch pool account to get lpMint and vault
        const poolInfo = await connection.getAccountInfo(pool);
        if (!poolInfo || poolInfo.data.length < STAKE_POOL_SIZE_V1) {
          throw new Error('Stake pool not initialized for this market.');
        }

        // Defense-in-depth: validate pool account owner matches stake program.
        // The pool is a PDA so an attacker cannot substitute a malicious account,
        // but this guards against edge cases in test environments or network misconfigs.
        if (!poolInfo.owner.equals(stakeProgramId)) {
          throw new Error('Stake pool account owner mismatch — possible network misconfiguration.');
        }

        // Decode pool using the REAL deployed 352-byte v1 layout — NOT the SDK's
        // decodeStakePool, which assumes a 384-byte v2 layout that was never
        // deployed here (see STAKE_POOL_SIZE_V1 comment in useStakePool.ts).
        const { lpMint, vault } = decodeStakePoolV1(poolInfo.data);

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
        const data = Buffer.from(encodeStakeWithdraw(lpAmount));
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
            programId: stakeProgramId,
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
