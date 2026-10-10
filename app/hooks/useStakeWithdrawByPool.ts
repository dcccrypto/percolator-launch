'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
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
import { isDevnetV22Enabled } from '@/lib/v22/flag';
import { readFirstLossPool } from '@/lib/v22/stake-v5';
import { ACCOUNTS_STAKE_WITHDRAW_V5, deriveInsuranceUnitsV22, stakeMetasV5 } from '@/lib/v22/sdk';
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
          ?? DEVNET_PROGRAM_IDS.stake
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

        // Decode the fields needed (lpMint, vault) via decodeStakePoolV1 — offsets
        // are identical across the retired 352-byte and deployed 392-byte layouts
        // (see STAKE_POOL_SIZE_V1 comment in useStakePool.ts).
        const { lpMint, vault, slab: poolSlab } = decodeStakePoolV1(poolInfo.data);
        // percolator-stake #290 (v18.2): the ix carries the pool's wrapper market
        // (`pool.slab`) as a trailing account, and the program rejects any key other
        // than pool.slab. The pool PDA is derived from slabPk, so these must agree;
        // fail here with a clear message rather than on-chain.
        if (!poolSlab.equals(slabPk)) {
          throw new Error('Stake pool belongs to a different market (pool.slab mismatch).');
        }

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
        // Devnet v2.2 (flag-gated): a first-loss v5 pool takes the 14-account withdraw (market + insurance units +
        // wrapper program). Pays only from the pool's liquid part; the program refuses more with 36.
        const v5 = isDevnetV22Enabled() ? readFirstLossPool(new Uint8Array(poolInfo.data)) : null;
        const keys = v5
          ? stakeMetasV5(ACCOUNTS_STAKE_WITHDRAW_V5, {
              user: wallet.publicKey,
              pool,
              userLp: userLpAta,
              lpMint,
              vault,
              userCollateral: userCollateralAta,
              vaultAuthority: vaultAuth,
              deposit: depositPda,
              market: v5.slab,
              insuranceUnits: deriveInsuranceUnitsV22(v5.percolatorProgram, v5.slab)[0],
              wrapperProgram: v5.percolatorProgram,
            })
          : withdrawAccounts({
          user: wallet.publicKey,
          pool,
          userLpAta,
          lpMint,
          vault,
          userCollateralAta,
          vaultAuth,
          depositPda,
          slab: poolSlab,
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
