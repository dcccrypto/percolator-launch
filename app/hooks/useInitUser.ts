"use client";

import { useCallback, useRef, useState } from "react";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import {
  encodeInitUser,
  encodeDepositCollateral,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
  detectSlabLayout,
  isV17Account,
  V17_PORTFOLIO_ACCOUNT_LEN,
  deriveVaultAuthority,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { findOwnerPortfolio } from "@/lib/owner-portfolio";
import { useSlabState } from "@/components/providers/SlabProvider";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { humanizeError } from "@/lib/errorMessages";
import { fetchPortfolioIdentity } from "@/lib/v18-wire";
import { assertDepositWithinBalance, DepositExceedsBalanceError } from "@/lib/deposit-guard";
import { readU64LE } from "@/lib/u64le";
import { assertV1AllowsNewFunds } from "@/lib/v21/move/close-only";

/** Shared discovery (lib/owner-portfolio.ts): `null` only when the scan found
 *  none; an RPC failure throws PortfolioLookupError instead of reading as "no
 *  account" and creating a duplicate portfolio (M-4). */
const findV17PortfolioForInit = findOwnerPortfolio;

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
  const inflightRef = useRef(false);

  // PERC-onboarding-1: initUser resolves with how much collateral actually
  // moved (0n when the account was created but nothing was deposited — no
  // wallet balance, the deposit leg failed, etc). Returned on the promise
  // itself (not hook state) deliberately — a caller reading hook state right
  // after `await initUser(...)` would see a STALE snapshot from before this
  // call's setState lands (React state updates aren't visible synchronously
  // inside the same async closure), which is exactly the kind of "reads a
  // snapshot from before the actual result" bug this file's callers need to
  // avoid (see useAutoDeposit.ts).
  const initUser = useCallback(
    async (feePayment?: bigint): Promise<{ sig: string; depositedAmount: bigint } | undefined> => {
      // BUG 11: useInitUser is called from 3 independent instances (OrderTicket,
      // DepositWithdrawCard, useAutoDeposit post-faucet) whose disabled-states
      // don't share, so this only stops re-entrant calls through THIS hook
      // instance (mirrors useTrade/useDeposit's inflightRef). The deterministic
      // sort in findV17PortfolioForInit above is what keeps every instance
      // converged on the same portfolio if a cross-instance race still slips
      // a second one into existence.
      if (inflightRef.current) throw new Error("Account setup already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        // Defense-in-depth: refuse to build a tx whose programId is not in
        // our deployed allowlist. See SlabProvider.parseSlab for the primary gate.
        assertKnownProgram(slabProgramId);
        // Move flow: account creation folds in a deposit (and exists only to trade), so on a v1
        // close-only market the whole setup is refused. Wallets with an account are unaffected.
        assertV1AllowsNewFunds(slabProgramId, "deposit");

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

          // ── PERC-onboarding-1: first-trade-setup — fold Deposit into the SAME
          // transaction as InitPortfolio when the caller passed an amount and
          // the wallet already holds sim-USDC. Previously `feePayment` was a
          // v12-only concept and was silently dropped on v17 (this hook's
          // header comment claimed "initUser + deposit in a single
          // transaction" but only ever created the account) — the user then
          // needed a second, separate manual deposit with no indication one
          // was required. Reuses useDeposit.ts's exact v17 Deposit account
          // list/encoder (ACCOUNTS_DEPOSIT_COLLATERAL / encodeDepositCollateral
          // / deriveVaultAuthority) — not hand-rolled.
          const requestedDeposit = feePayment != null && feePayment > 0n ? feePayment : 0n;
          // v18: DepositCollateral binds the portfolio's live portfolioId +
          // matcher-sequence, which are only known AFTER the account is created
          // (the id is program-assigned at InitUser). So we can NOT bundle Deposit
          // into the same tx as init — capture the deposit accounts here and build
          // the Deposit ix in a SECOND tx once the identity can be read live.
          let depositAccounts: { userAta: PublicKey; vaultTokenAta: PublicKey } | null = null;
          let clampedDeposit = 0n;
          if (requestedDeposit > 0n) {
            try {
              const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);
              const [vaultPda] = deriveVaultAuthority(programId, slabPk);
              const vaultTokenAta = await getAta(vaultPda, mktConfig.collateralMint, true);
              // Distinguish "ATA genuinely absent" (0 is correct — user holds no
              // collateral yet) from "the balance READ failed" (a transient RPC
              // hiccup — unknown, NOT zero). getTokenAccountBalance threw for both
              // and the old catch clamped the deposit to 0, so on a rate-limited
              // read the user got an init-only account with their funds left
              // behind and no error (#2547). getAccountInfo returns null for an
              // absent account and throws ONLY on a real read failure.
              let ataInfo: Awaited<ReturnType<typeof connection.getAccountInfo>> = null;
              let readFailed = false;
              try {
                ataInfo = await connection.getAccountInfo(userAta);
              } catch {
                readFailed = true;
              }
              if (readFailed) {
                // Read failed — do NOT silently drop the deposit. Proceed with the
                // full requested amount; the on-chain Deposit tx validates the real
                // balance and surfaces an accurate error if it is insufficient.
                clampedDeposit = requestedDeposit;
                depositAccounts = { userAta, vaultTokenAta };
              } else if (ataInfo === null) {
                // ATA absent: the wallet holds none, so any requested deposit
                // is over-balance — refuse rather than silently init-only.
                assertDepositWithinBalance(requestedDeposit, 0n);
                clampedDeposit = 0n;
                depositAccounts = null;
              } else {
                // SPL / Token-2022 token account: amount is a u64 LE at offset 64.
                const ataBalance =
                  ataInfo.data.length >= 72 ? readU64LE(ataInfo.data, 64) : 0n;
                // Never SILENTLY shrink the deposit: an over-balance request
                // used to be clamped here, so the user typed N and only the
                // wallet's (smaller) balance moved with no warning. Refuse
                // instead — BEFORE the account-creation tx is sent.
                assertDepositWithinBalance(requestedDeposit, ataBalance);
                clampedDeposit = requestedDeposit;
                depositAccounts = clampedDeposit > 0n ? { userAta, vaultTokenAta } : null;
              }
            } catch (guardErr) {
              if (guardErr instanceof DepositExceedsBalanceError) throw guardErr;
              // Deterministic setup (ATA / vault derivation) failed — fall through
              // to init-only; the user can deposit manually afterward.
              depositAccounts = null;
              clampedDeposit = 0n;
            }
          }

          /** Build the v18 Deposit ix, live-reading the portfolio's identity CAS
           *  fields (only valid AFTER the init tx has confirmed the account). */
          const ownerPk = wallet.publicKey; // narrowed non-null here; captured for the closure
          const buildDepositIx = async (): Promise<TransactionInstruction> => {
            const acc = depositAccounts!;
            const depId = await fetchPortfolioIdentity(connection, portfolioPk);
            return buildIx({
              programId,
              keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
                ownerPk,
                slabPk,
                portfolioPk,
                acc.userAta,
                acc.vaultTokenAta,
                WELL_KNOWN.tokenProgram,
              ]),
              data: encodeDepositCollateral({
                portfolioId: depId.portfolioId,
                expectedSequence: depId.matcherSequence,
                amount: clampedDeposit.toString(),
              }),
            });
          };

          const baseInstructions: TransactionInstruction[] = [createPortfolioIx, initPortfolioIx];

          // PERC-8388: Lighthouse/Blowfish 0x1900 assertion injection — retry with skipPreflight.
          const sendV17 = async (ixs: TransactionInstruction[], signers?: Keypair[]): Promise<string> => {
            try {
              return await sendTx({ connection, wallet, instructions: ixs, signers });
            } catch (sendError) {
              const errMsg = sendError instanceof Error ? sendError.message : String(sendError);
              const isLighthouse =
                /custom program error:\s*0x1900\b/i.test(errMsg) ||
                /L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95/i.test(errMsg) ||
                (/"Custom"\s*:\s*6400/.test(errMsg) && /InstructionError/.test(errMsg));
              if (isLighthouse) {
                console.warn(
                  "[useInitUser] Lighthouse/Blowfish assertion failed (0x1900). " +
                  "Retrying with skipPreflight=true — error comes from wallet middleware, not our program.",
                );
                return await sendTx({ connection, wallet, instructions: ixs, signers, skipPreflight: true });
              }
              throw sendError;
            }
          };

          // v18: init and deposit are ALWAYS two txs. The portfolio's
          // program-assigned portfolioId (bound into DepositCollateral) is only
          // known once the InitUser tx has landed, so Deposit cannot ride in the
          // same atomic tx. Account creation must succeed on its own merits; the
          // deposit leg is best-effort on top of it (from the caller's POV this is
          // still one "Setting up your account…" action).
          let sig = await sendV17(baseInstructions, [portfolioKp]);
          let depositedAmount = 0n;
          if (depositAccounts && clampedDeposit > 0n) {
            try {
              const depositIx = await buildDepositIx();
              sig = await sendV17([depositIx]);
              depositedAmount = clampedDeposit;
            } catch (depositErr) {
              // Account exists; auto-deposit just didn't land. Not fatal —
              // depositedAmount stays 0n on the resolved result so the caller can
              // still prompt a manual deposit, not a scary top-level error.
              if (process.env.NODE_ENV === "development") {
                console.warn("[useInitUser] follow-up deposit tx failed:", depositErr);
              }
            }
          }

          if (process.env.NODE_ENV === "development") {
            console.log(
              "[useInitUser] v17 portfolio initialized:", portfolioPk.toBase58(),
              "sig:", sig, "deposited:", depositedAmount.toString(),
            );
          }

          refreshSlab();
          setTimeout(() => refreshSlab(), 2000);
          return { sig, depositedAmount };
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
        return { sig, depositedAmount: effectiveFee };
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
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAddress, slabProgramId, slabRaw, params, refreshSlab],
  );

  return { initUser, loading, error };
}
