"use client";

import { useCallback, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeDepositCollateral,
  encodeInitUser,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_INIT_USER,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
  AccountKind,
} from "@percolator/sdk";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";

export function useDeposit(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, accounts: slabAccounts, programId: slabProgramId, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const deposit = useCallback(
    async (params: { userIdx: number; amount: bigint }) => {
      if (inflightRef.current) throw new Error("Deposit already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        
        // P-CRITICAL-3: Validate network before deposit
        try {
          const slabInfo = await connection.getAccountInfo(new PublicKey(slabAddress));
          if (!slabInfo) {
            throw new Error("Market not found on current network. Please switch networks in your wallet and refresh.");
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes("Market not found")) throw e;
        }
        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);

        const instructions = [];

        // Auto-create ATA if needed
        try {
          await getAccount(connection, userAta);
        } catch {
          instructions.push(
            createAssociatedTokenAccountInstruction(
              wallet.publicKey, userAta, wallet.publicKey, mktConfig.collateralMint,
            ),
          );
        }

        // P0 FIX: Auto-InitUser if user has no account on this slab.
        // Previously, deposit required the user to manually click "Create Account"
        // first. Now we bundle InitUser + Deposit in a single tx, making the
        // experience seamless — user just clicks "Deposit" and it works.
        const pkStr = wallet.publicKey.toBase58();
        const hasAccount = slabAccounts.some(
          ({ account }) => account.kind === AccountKind.User && account.owner.toBase58() === pkStr
        );

        if (!hasAccount) {
          // InitUser with feePayment=0 (deposit will follow as separate ix)
          const initIx = buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
              wallet.publicKey, slabPk, userAta, mktConfig.vaultPubkey, WELL_KNOWN.tokenProgram,
            ]),
            data: encodeInitUser({ feePayment: "0" }),
          });
          instructions.push(initIx);

          // After InitUser, the user's idx will be the next available slot.
          // We need to re-read the slab to find the new idx, but since we're
          // bundling in one tx, we can't do that. Instead, use the total
          // account count (InitUser assigns the next sequential idx).
          // The userIdx param won't be used for InitUser, but we need it for
          // the deposit ix that follows. Count existing accounts to predict idx.
          const userCount = slabAccounts.filter(
            ({ account }) => account.kind === AccountKind.User
          ).length;
          // Override the userIdx for deposit to use the newly created account
          params = { ...params, userIdx: userCount };
        }

        const depositIx = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
            wallet.publicKey, slabPk, userAta, mktConfig.vaultPubkey, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
          ]),
          data: encodeDepositCollateral({ userIdx: params.userIdx, amount: params.amount.toString() }),
        });
        instructions.push(depositIx);

        const sig = await sendTx({ connection, wallet, instructions, computeUnits: 400_000 });
        // P0 fix: force immediate slab re-read so balance updates without waiting
        // for the next poll cycle (which can be up to 30s when WS is active).
        refreshSlab();
        // Re-read again after a short delay to catch any propagation lag on devnet RPCs.
        setTimeout(() => refreshSlab(), 2000);
        return sig;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAccounts, slabAddress, slabProgramId, refreshSlab]
  );

  return { deposit, loading, error };
}
