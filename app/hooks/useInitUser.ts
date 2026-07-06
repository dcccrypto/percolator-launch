"use client";

import { useCallback, useState } from "react";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import {
  encodeInitUser,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
  detectSlabLayout,
  isV17Account,
  V17_PORTFOLIO_ACCOUNT_LEN,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { humanizeError } from "@/lib/errorMessages";

// ---------------------------------------------------------------------------
// v17 portfolio discovery helper — mirrors useDeposit's findV17Portfolio.
// Kept here (rather than a shared util) so useInitUser has no cross-hook
// import dependency; logic MUST stay byte-for-byte identical to useDeposit.ts.
// ---------------------------------------------------------------------------

// V17 magic bytes at offset 0: PERCV16\0 in raw form [0x00,0x36,0x31,0x56,0x43,0x52,0x45,0x50]
const V17_PORTFOLIO_MAGIC_INIT = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

// market_group_id at HEADER_LEN(16) + provenance.market_group_id(0) = offset 16
const V17_PF_MARKET_OFF = 16;
// owner at HEADER_LEN(16) + 64 = offset 80
const V17_PF_OWNER_OFF = 80;

async function findV17PortfolioForInit(
  connection: import("@solana/web3.js").Connection,
  programId: PublicKey,
  marketPk: PublicKey,
  ownerPk: PublicKey,
): Promise<PublicKey | null> {
  try {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_INIT.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: V17_PF_MARKET_OFF, bytes: marketPk.toBase58() } },
        { memcmp: { offset: V17_PF_OWNER_OFF, bytes: ownerPk.toBase58() } },
      ],
    });
    if (accounts.length === 0) return null;
    return accounts[0].pubkey;
  } catch {
    return null;
  }
}

// Full v17 portfolio account size — must match V17_PORTFOLIO_ACCOUNT_LEN from SDK.
// InitPortfolio reallocs to this size and does NOT add lamports, so the CreateAccount
// rent must cover the full 9347 bytes or InitPortfolio fails with InsufficientFundsForRent.
const V17_PORTFOLIO_ACCOUNT_SIZE = V17_PORTFOLIO_ACCOUNT_LEN;

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
        // Defense-in-depth: refuse to build a tx whose programId is not in
        // our deployed allowlist. See SlabProvider.parseSlab for the primary gate.
        assertKnownProgram(slabProgramId);

        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);

        // ── v17 vs v12 dispatch ──────────────────────────────────────────────
        const isV17 = slabRaw && slabRaw.length > 0 && isV17Account(slabRaw);

        if (isV17) {
          // v17 path: portfolio accounts are standalone keypair-addressed accounts.
          // InitPortfolio (tag 1) = 3 accounts [owner(s,w), market(w), portfolio(w)], zero data bytes.
          // No fee payment; new_account_fee concept does not apply in v17.

          // If a portfolio already exists for this wallet+market, nothing to do.
          const existing = await findV17PortfolioForInit(connection, programId, slabPk, wallet.publicKey);
          if (existing) {
            // Portfolio already exists — skip silently; refreshSlab so callers see the account.
            refreshSlab();
            setTimeout(() => refreshSlab(), 2000);
            return undefined;
          }

          const portfolioKp = Keypair.generate();
          const portfolioPk = portfolioKp.publicKey;

          const portfolioRent = await connection.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_SIZE);
          const createPortfolioIx = SystemProgram.createAccount({
            fromPubkey: wallet.publicKey,
            newAccountPubkey: portfolioPk,
            lamports: portfolioRent,
            space: V17_PORTFOLIO_ACCOUNT_SIZE,
            programId,
          });
          const initPortfolioIx = buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
              wallet.publicKey,
              slabPk,
              portfolioPk,
            ]),
            data: encodeInitUser({}),
          });

          let sig: string;
          try {
            sig = await sendTx({
              connection,
              wallet,
              instructions: [createPortfolioIx, initPortfolioIx],
              signers: [portfolioKp],
            });
          } catch (sendError) {
            const errMsg = sendError instanceof Error ? sendError.message : String(sendError);
            // PERC-8388: Lighthouse/Blowfish 0x1900 assertion injection — retry with skipPreflight.
            const isLighthouse =
              /custom program error:\s*0x1900\b/i.test(errMsg) ||
              /L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95/i.test(errMsg) ||
              (/"Custom"\s*:\s*6400/.test(errMsg) && /InstructionError/.test(errMsg));
            if (isLighthouse) {
              console.warn(
                "[useInitUser] Lighthouse/Blowfish assertion failed (0x1900). " +
                "Retrying with skipPreflight=true — error comes from wallet middleware, not our program.",
              );
              sig = await sendTx({
                connection,
                wallet,
                instructions: [createPortfolioIx, initPortfolioIx],
                signers: [portfolioKp],
                skipPreflight: true,
              });
            } else {
              throw sendError;
            }
          }

          if (process.env.NODE_ENV === "development") {
            console.log("[useInitUser] v17 portfolio initialized:", portfolioPk.toBase58(), "sig:", sig);
          }

          refreshSlab();
          setTimeout(() => refreshSlab(), 2000);
          return sig;
        }

        // ── v12 legacy path ─────────────────────────────────────────────────

        // The on-chain v12 InitUser handler requires:
        //   1. fee_payment >= new_account_fee
        //   2. fee_payment >= min_initial_deposit
        // Use the greater of the two as the floor.
        const accountFee = params?.newAccountFee ?? 0n;
        const minDeposit = params?.minInitialDeposit ?? 0n;
        const minFee = accountFee + minDeposit;
        const effectiveFee = (feePayment != null && feePayment >= minFee) ? feePayment : minFee;

        // PERC-698: Pre-flight V0/V1 slab version check.
        if (slabRaw && slabRaw.length > 0) {
          const layout = detectSlabLayout(slabRaw.length);
          if (layout?.version === 0) {
            throw new Error(
              "This market uses an older format (V0) that is incompatible with the current " +
              "program version. The market creator needs to re-initialize it. " +
              "Please try a different market or contact support.",
            );
          }
        }

        const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);

        // Check if ATA exists — create it first if not (prevents error 24)
        const instructions = [];
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

        // v12 InitUser wire: [user(s,w), slab(w), userAta(w), vault(w), tokenProgram, clock]
        // ACCOUNTS_INIT_USER is now v17 (3 accounts); use ACCOUNTS_INIT_LP for the
        // v12-compatible 6-account layout (same wire format as the old v12 InitUser).
        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_INIT_LP, [
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
          // PERC-8388: Lighthouse/Blowfish 0x1900 assertion — retry with skipPreflight.
          const isLighthouse =
            /custom program error:\s*0x1900\b/i.test(errMsg) ||
            /L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95/i.test(errMsg) ||
            (/"Custom"\s*:\s*6400/.test(errMsg) && /InstructionError/.test(errMsg));
          if (isLighthouse) {
            console.warn(
              "[useInitUser] Lighthouse/Blowfish assertion failed (0x1900). " +
              "Retrying with skipPreflight=true — this is safe because the " +
              "error comes from wallet middleware, not our program.",
            );
            sig = await sendTx({ connection, wallet, instructions, skipPreflight: true });
          } else {
            throw sendError;
          }
        }
        // Force immediate slab re-read so the new user sub-account is visible.
        refreshSlab();
        setTimeout(() => refreshSlab(), 2000);
        return sig;
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        // PERC-698: Custom program error 0x4 = InvalidSlabLen — V0/V1 program mismatch.
        const is0x4 = /custom program error:\s*0x4\b/i.test(raw);
        // PERC-8388: Lighthouse/Blowfish 0x1900 — wallet middleware assertion failure.
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
          : humanizeError(raw);
        setError(userMsg);
        throw new Error(userMsg);
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAddress, slabProgramId, slabRaw, params, refreshSlab],
  );

  return { initUser, loading, error };
}
