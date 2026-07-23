"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveDepositPda,
  encodeStakeDepositJunior,
  depositAccounts,
} from "@percolatorct/sdk";
import { STAKE_POOL_SIZE_V1, decodeStakePoolV1 } from "@/hooks/useStakePool";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { sendTx } from "@/lib/tx";
import { getConfig } from "@/lib/config";

export interface StakeDepositJuniorParams {
  /** The slab (market) address this pool belongs to. Used for PDA derivation. */
  slabAddress: string;
  /** SPL mint for pool collateral (USDC). */
  collateralMint: string;
}

/**
 * Hook for depositing into the junior (first-loss) tranche of a stake pool.
 *
 * Mirrors useStakeDepositByPool but encodes a DepositJunior instruction
 * (tag 16, PERC-303) instead of the standard senior Deposit (tag 3).
 * The same pool account, vault, and LP mint are used — the on-chain program
 * handles the tranche accounting.
 *
 * ⚠ NOT currently wired into the UI (see stake/page.tsx). Tranches (tag 16,
 * PERC-303) are part of the newer 384-byte v2 StakePool layout; the deployed
 * devnet vault program (51CeUNpb…) still runs the 352-byte v1 program, which
 * has no tag-16 handler — sending this instruction to it will fail on-chain.
 * Re-enable the Junior tranche option once the v2 program is deployed here.
 *
 * Usage:
 * ```tsx
 * const { deposit, loading, error } = useStakeDepositJunior({
 *   slabAddress: pool.slabAddress,
 *   collateralMint: pool.collateralMint,
 * });
 * await deposit(1_000_000n); // 1 USDC (6 decimals)
 * ```
 */
export function useStakeDepositJunior({ slabAddress, collateralMint }: StakeDepositJuniorParams) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  // Reset UI state when the selected pool changes — same pattern as useStakeDepositByPool.
  useEffect(() => {
    setError(null);
    setLoading(false);
  }, [slabAddress, collateralMint]);

  const deposit = useCallback(
    async (amount: bigint) => {
      if (inflightRef.current) throw new Error("Junior stake deposit already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);

      try {
        if (!wallet.publicKey || !wallet.signTransaction) {
          throw new Error("Wallet not connected");
        }
        if (!slabAddress || !collateralMint) {
          throw new Error("Pool not selected");
        }
        if (amount <= 0n) {
          throw new Error("Deposit amount must be greater than zero");
        }

        const slabPk = new PublicKey(slabAddress);
        const collMintPk = new PublicKey(collateralMint);

        // Validate slab exists on-chain (mirrors P-CRITICAL-3 network check in senior hook)
        const slabInfo = await connection.getAccountInfo(slabPk);
        if (!slabInfo) {
          throw new Error(
            "Market not found on current network. Please switch networks in your wallet and refresh."
          );
        }

        // Stake pools are owned by this deployment's vault program (getConfig().vaultProgramId),
        // NOT the SDK's default stake program id. Derive all PDAs against the correct program.
        const stakeProgramId = new PublicKey(
          (getConfig() as { vaultProgramId?: string }).vaultProgramId
          ?? "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3"
        );

        // Derive all PDAs
        const [pool] = deriveStakePool(slabPk, stakeProgramId);
        const [vaultAuth] = deriveStakeVaultAuth(pool, stakeProgramId);
        const [depositPda] = deriveDepositPda(pool, wallet.publicKey, stakeProgramId);

        // Fetch pool account to get lpMint and vault addresses
        const poolInfo = await connection.getAccountInfo(pool);
        if (!poolInfo || poolInfo.data.length < STAKE_POOL_SIZE_V1) {
          throw new Error("Stake pool not initialized for this market. Contact admin.");
        }

        if (!poolInfo.owner.equals(stakeProgramId)) {
          throw new Error(
            "Stake pool account owner mismatch — possible network misconfiguration."
          );
        }

        // Decode pool using the REAL deployed 352-byte v1 layout — NOT the SDK's
        // decodeStakePool, which assumes a 384-byte v2 layout that was never
        // deployed here (see STAKE_POOL_SIZE_V1 comment in useStakePool.ts).
        const { lpMint, vault } = decodeStakePoolV1(poolInfo.data);

        const userCollateralAta = await getAssociatedTokenAddress(collMintPk, wallet.publicKey);
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
              collMintPk
            )
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
              lpMint
            )
          );
        }

        // Build DepositJunior instruction (tag 16, PERC-303).
        // Same account layout as senior Deposit — the on-chain program differentiates
        // tranches via the instruction discriminator.
        const data = Buffer.from(encodeStakeDepositJunior(amount));
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
            programId: stakeProgramId,
            keys,
            data,
          })
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
    [connection, wallet, slabAddress, collateralMint]
  );

  return { deposit, loading, error };
}
