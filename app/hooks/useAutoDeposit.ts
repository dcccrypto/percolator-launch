/**
 * PERC-372: Auto-deposit hook
 *
 * Full zero-to-trading flow on wallet connect (devnet only):
 *   1. Detect zero token balance → call /api/auto-fund (SOL airdrop + USDC mint)
 *   2. Detect no protocol user account → init user account on-chain
 *   3. Detect zero collateral → deposit tokens into the user account
 *
 * Fires once per session per wallet+market. Non-blocking — runs in background.
 * Surfaces progress via status state so UI can show a toast/banner.
 */

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";
import {
  encodeInitUser,
  encodeDepositCollateral,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
  AccountKind,
} from "@percolator/sdk";
import { sendTx } from "@/lib/tx";

export type AutoDepositStatus =
  | "idle"
  | "funding"       // Requesting SOL + USDC from faucet
  | "creating"      // Creating user account on-chain
  | "depositing"    // Depositing collateral
  | "done"          // All steps complete
  | "error";

/** Default deposit amount: 100 USDC (6 decimals) */
const DEFAULT_DEPOSIT_AMOUNT = 100_000_000n;

/** Minimum token balance to skip auto-deposit (1 USDC) */
const MIN_TOKEN_BALANCE = 1_000_000n;

export function useAutoDeposit(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, programId: slabProgramId, accounts } = useSlabState();
  const userAccount = useUserAccount();

  const [status, setStatus] = useState<AutoDepositStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const attemptedRef = useRef<Set<string>>(new Set());

  const run = useCallback(async () => {
    if (!wallet.publicKey || !wallet.connected || !mktConfig || !slabProgramId) return;

    const isDevnet = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "devnet";
    if (!isDevnet) return;

    const key = `${wallet.publicKey.toBase58()}:${slabAddress}`;
    if (attemptedRef.current.has(key)) return;
    attemptedRef.current.add(key);

    const programId = slabProgramId;
    const slabPk = new PublicKey(slabAddress);

    try {
      // Step 1: Check token balance, fund if zero
      const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);
      let tokenBalance = 0n;
      try {
        const acct = await getAccount(connection, userAta);
        tokenBalance = acct.amount;
      } catch {
        // ATA doesn't exist — balance is zero
      }

      if (tokenBalance < MIN_TOKEN_BALANCE) {
        setStatus("funding");
        try {
          const resp = await fetch("/api/auto-fund", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallet: wallet.publicKey.toBase58() }),
          });
          if (!resp.ok && resp.status !== 429) {
            const data = await resp.json().catch(() => ({}));
            console.warn("[auto-deposit] Fund failed:", data.error);
          }
          // Wait for confirmation to propagate
          await new Promise((r) => setTimeout(r, 2000));

          // Re-check balance
          try {
            const acct = await getAccount(connection, userAta);
            tokenBalance = acct.amount;
          } catch {
            // Still no ATA — funding may have failed, continue anyway
          }
        } catch (e) {
          console.warn("[auto-deposit] Fund request error:", e);
        }
      }

      // Step 2: Check if user account exists, create if not
      if (!userAccount) {
        setStatus("creating");

        const instructions = [];

        // Ensure ATA exists
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

        // Init user account
        const initIx = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
            wallet.publicKey,
            slabPk,
            userAta,
            mktConfig.vaultPubkey,
            WELL_KNOWN.tokenProgram,
          ]),
          data: encodeInitUser({ feePayment: "0" }),
        });
        instructions.push(initIx);

        await sendTx({ connection, wallet, instructions });

        // Small delay for state to propagate
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Step 3: Deposit collateral if user has tokens but zero collateral
      // Re-read user account after potential creation
      const freshAccounts = accounts;
      const pkStr = wallet.publicKey.toBase58();
      const currentUser = freshAccounts.find(
        ({ account }) =>
          account.kind === AccountKind.User && account.owner.toBase58() === pkStr,
      );

      if (currentUser && tokenBalance >= MIN_TOKEN_BALANCE) {
        const collateral = currentUser.account.capital ?? 0n;
        if (collateral === 0n) {
          setStatus("depositing");

          // Deposit up to DEFAULT_DEPOSIT_AMOUNT or whatever they have
          const depositAmt =
            tokenBalance < DEFAULT_DEPOSIT_AMOUNT ? tokenBalance : DEFAULT_DEPOSIT_AMOUNT;

          const depositIx = buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
              wallet.publicKey,
              slabPk,
              await getAta(wallet.publicKey, mktConfig.collateralMint),
              mktConfig.vaultPubkey,
              WELL_KNOWN.tokenProgram,
              WELL_KNOWN.clock,
            ]),
            data: encodeDepositCollateral({
              userIdx: currentUser.idx,
              amount: depositAmt.toString(),
            }),
          });

          await sendTx({ connection, wallet, instructions: [depositIx] });

          // State will refresh on next poll cycle
        }
      }

      setStatus("done");
    } catch (e: any) {
      console.error("[auto-deposit] Error:", e);
      setError(e.message ?? "Auto-deposit failed");
      setStatus("error");
    }
  }, [wallet, connection, mktConfig, slabProgramId, slabAddress, userAccount, accounts]);

  // Trigger on wallet connect
  useEffect(() => {
    if (wallet.connected && wallet.publicKey && mktConfig) {
      run();
    }
  }, [wallet.connected, wallet.publicKey, mktConfig, run]);

  return { status, error };
}
