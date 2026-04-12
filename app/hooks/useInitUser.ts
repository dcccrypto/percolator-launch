"use client";

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import {
  encodeInitUser,
  ACCOUNTS_INIT_USER,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
  detectSlabLayout,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";


export function useInitUser(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, programId: slabProgramId, raw: slabRaw, params, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initUser = useCallback(
    async (feePayment?: bigint) => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");

        // The on-chain InitUser handler requires:
        //   1. fee_payment >= new_account_fee (account registration fee)
        //   2. fee_payment >= min_initial_deposit (engine.deposit minimum for new accounts)
        // Both checks return Custom:13 (EngineInsufficientBalance).
        // Use the greater of the two as the floor.
        // feePayment must cover BOTH the one-time account fee AND leave at least
        // minInitialDeposit as capital. So minimum = accountFee + minInitialDeposit.
        const accountFee = params?.newAccountFee ?? 0n;
        const minDeposit = params?.minInitialDeposit ?? 0n;
        const minFee = accountFee + minDeposit;
        const effectiveFee = (feePayment != null && feePayment >= minFee) ? feePayment : minFee;

        // PERC-698 / bug bounty: Pre-flight V0/V1 slab version check.
        // If the slab is V0 size but the on-chain program now expects V1 layout,
        // the InitUser tx will fail with custom program error 0x4 (InvalidSlabLen).
        // Detect this mismatch proactively and surface a clear message.
        if (slabRaw && slabRaw.length > 0) {
          const layout = detectSlabLayout(slabRaw.length);
          if (layout?.version === 0) {
            throw new Error(
              "This market uses an older format (V0) that is incompatible with the current " +
              "program version. The market creator needs to re-initialize it. " +
              "Please try a different market or contact support."
            );
          }
        }
        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);

        // Check if ATA exists — create it first if not (prevents error 24)
        const instructions = [];
        try {
          await getAccount(connection, userAta);
        } catch {
          // ATA doesn't exist — create it
          const createAtaIx = createAssociatedTokenAccountInstruction(
            wallet.publicKey,     // payer
            userAta,              // ata
            wallet.publicKey,     // owner
            mktConfig.collateralMint, // mint
          );
          instructions.push(createAtaIx);
        }

        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
            wallet.publicKey, slabPk, userAta, mktConfig.vaultPubkey, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
          ]),
          data: encodeInitUser({ feePayment: effectiveFee.toString() }),
        });
        instructions.push(ix);
        let sig: string;
        try {
          sig = await sendTx({ connection, wallet, instructions });
        } catch (sendError) {
          const errMsg = sendError instanceof Error ? sendError.message : String(sendError);
          // PERC-8388: Lighthouse/Blowfish wallet middleware injects assertion
          // instructions that fail with 0x1900 (AssertionFailed) during simulation.
          // The error is NOT from our program — detect it and retry with
          // skipPreflight so the tx skips RPC simulation. The on-chain program
          // itself validates correctly without Lighthouse assertions.
          const isLighthouse =
            /custom program error:\s*0x1900\b/i.test(errMsg) ||
            /L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95/i.test(errMsg) ||
            (/"Custom"\s*:\s*6400/.test(errMsg) && /InstructionError/.test(errMsg));

          if (isLighthouse) {
            console.warn(
              "[useInitUser] Lighthouse/Blowfish assertion failed (0x1900). " +
              "Retrying with skipPreflight=true — this is safe because the " +
              "error comes from wallet middleware, not our program."
            );
            sig = await sendTx({ connection, wallet, instructions, skipPreflight: true });
          } else {
            throw sendError;
          }
        }
        // Force immediate slab re-read so the new user sub-account is visible
        // without waiting for the next poll cycle (up to 30 s with WS active).
        refreshSlab();
        setTimeout(() => refreshSlab(), 2000);
        return sig;
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        // PERC-698: Custom program error 0x4 = InvalidSlabLen — V0/V1 program mismatch.
        const is0x4 = /custom program error:\s*0x4\b/i.test(raw);
        // PERC-8388: Lighthouse/Blowfish 0x1900 — wallet middleware assertion failure.
        // If the skipPreflight retry in the try block above also failed, surface
        // a more helpful message than the raw Lighthouse error code.
        const is0x1900 =
          /custom program error:\s*0x1900\b/i.test(raw) ||
          (/"Custom"\s*:\s*6400/.test(raw) && /InstructionError/.test(raw));
        const userMsg = is0x4
          ? "This market uses an older format that's incompatible with the current program version. " +
            "The market creator needs to re-initialize it. Please try a different market or contact support."
          : is0x1900
          ? "Your wallet's transaction guard (Blowfish/Lighthouse) is blocking this transaction. " +
            "Try disabling transaction simulation in your wallet settings, or use a wallet without " +
            "Blowfish protection (e.g. Backpack). We're working on a permanent fix."
          : raw;
        setError(userMsg);
        throw new Error(userMsg);
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAddress, slabProgramId, slabRaw, params, refreshSlab]
  );

  return { initUser, loading, error };
}
