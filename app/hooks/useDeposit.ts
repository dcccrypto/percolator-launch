"use client";

import { useCallback, useRef, useState } from "react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
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
  parseAllAccounts,
  AccountKind,
} from "@percolator/sdk";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";

export function useDeposit(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, programId: slabProgramId, params: slabParams, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const deposit = useCallback(
    async (params: { userIdx: number; amount: bigint; accountExists?: boolean }) => {
      if (inflightRef.current) throw new Error("Deposit already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId)
          throw new Error("Wallet not connected or market not loaded");

        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);

        // ----------------------------------------------------------------
        // Network validation + P0 sub-account guard
        //
        // Fetch the slab on-chain. This serves two purposes:
        //   1. Validate we're on the right network (hard-fail if slab absent).
        //   2. Check whether the user has a sub-account on this slab.
        //      If not, prepend InitUser (tag 1) before DepositCollateral (tag 3).
        //      This prevents the silent on-chain failure that occurs when
        //      deposit is called for a user who has never traded this market.
        //
        // RACE CONDITION GUARD: If the caller sets accountExists=true (meaning
        // useUserAccount() confirmed the account in SlabProvider's state), we
        // skip the auto-init path entirely. This prevents a stale RPC response
        // from incorrectly treating an existing account as absent and prepending
        // a duplicate InitUser — which would fail on-chain and block all deposits
        // made immediately after account creation. See GH P0 bug: "Account created
        // but deposit fails after creation."
        //
        // If the RPC call itself throws (timeout, 429 etc.), we fall through
        // best-effort and let the chain surface any error naturally.
        // ----------------------------------------------------------------
        let slabData: Uint8Array | undefined;
        try {
          const slabInfo = await connection.getAccountInfo(slabPk);
          if (slabInfo === null) {
            throw new Error(
              "Market not found on current network. Please switch networks in your wallet and refresh.",
            );
          }
          if (slabInfo) {
            slabData = new Uint8Array(slabInfo.data);
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes("switch networks")) throw e;
          // RPC error — fall through, let the tx surface any on-chain failure
        }

        let resolvedUserIdx = params.userIdx;
        const instructions: TransactionInstruction[] = [];

        // Only run auto-init check if the caller hasn't confirmed the account exists.
        // When accountExists=true, the caller (DepositWithdrawCard) already verified
        // the account via useUserAccount() — skip the stale-slab re-check that would
        // incorrectly try to InitUser a second time.
        if (slabData && !params.accountExists) {
          try {
            const slabAccounts = parseAllAccounts(slabData);
            const pkStr = wallet.publicKey.toBase58();
            const userAcct = slabAccounts.find(
              ({ account }) =>
                account.kind === AccountKind.User &&
                account.owner.toBase58() === pkStr,
            );

            if (!userAcct) {
              // No sub-account for this wallet — new slot index = current count
              resolvedUserIdx = slabAccounts.length;

              // Ensure user ATA exists (prevents program error 24)
              try {
                await getAccount(connection, userAta);
              } catch {
                instructions.push(
                  createAssociatedTokenAccountInstruction(
                    wallet.publicKey,
                    userAta,
                    wallet.publicKey,
                    mktConfig.collateralMint,
                  ),
                );
              }

              // InitUser (tag 1) — must pay at least newAccountFee (PERC-1126)
              const accountFee = slabParams?.newAccountFee ?? 0n;
              instructions.push(
                buildIx({
                  programId,
                  keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
                    wallet.publicKey,
                    slabPk,
                    userAta,
                    mktConfig.vaultPubkey,
                    WELL_KNOWN.tokenProgram,
                    WELL_KNOWN.clock,
                  ]),
                  data: encodeInitUser({ feePayment: accountFee.toString() }),
                }),
              );
            }
          } catch (parseErr) {
            // Unexpected slab layout — fall through with original userIdx
            if (process.env.NODE_ENV === "development") {
              console.warn("[useDeposit] sub-account check failed:", parseErr);
            }
          }
        }

        // DepositCollateral (tag 3)
        instructions.push(
          buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
              wallet.publicKey,
              slabPk,
              userAta,
              mktConfig.vaultPubkey,
              WELL_KNOWN.tokenProgram,
              WELL_KNOWN.clock,
            ]),
            data: encodeDepositCollateral({
              userIdx: resolvedUserIdx,
              amount: params.amount.toString(),
            }),
          }),
        );

        const sig = await sendTx({ connection, wallet, instructions });

        // Force immediate slab re-read so balance updates without waiting for
        // the next poll cycle (which can be up to 30 s when WS is active).
        refreshSlab();
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
    [connection, wallet, mktConfig, slabAddress, slabProgramId, refreshSlab],
  );

  return { deposit, loading, error };
}
