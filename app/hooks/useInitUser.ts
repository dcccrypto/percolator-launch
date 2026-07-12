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
  parsePortfolioV17,
  V17_PORTFOLIO_ACCOUNT_LEN,
  deriveVaultAuthority,
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
// Mutable owner (SDK PF_OWNER_OFF) at HEADER_LEN(16) + provenance(100) = offset 116.
// NOT offset 80 (provenanceOwner — IMMUTABLE, set at creation). MintPositionNft moves
// the mutable owner to the escrow PDA on wrap but leaves provenance pointing at the
// original wallet, so filtering on 80 would treat a wrapped portfolio as still owned
// (blocking InitPortfolio for a wallet whose only portfolio here is wrapped).
const V17_PF_OWNER_OFF = 116;

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
    // BUG 11: with no cross-instance lock (OrderTicket / DepositWithdrawCard /
    // useAutoDeposit each mount their own useInitUser and can race through this
    // TOCTOU check concurrently), more than one portfolio can end up owned by
    // the same wallet on this market. getProgramAccounts's result order is not
    // guaranteed stable across calls/nodes, so picking accounts[0] as-is would
    // let different hook instances (and later deposit/trade) converge on
    // DIFFERENT accounts non-deterministically ("deposit disappeared"). Sort
    // deterministically by pubkey so every caller lands on the same one.
    const sorted =
      accounts.length > 1
        ? [...accounts].sort((a, b) => a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()))
        : accounts;
    // Defense-in-depth: re-verify the mutable owner actually matches after fetch —
    // memcmp filters are advisory server-side; don't trust them blindly.
    const data = sorted[0].account.data;
    const portfolio = parsePortfolioV17(data instanceof Buffer ? data : Buffer.from(data));
    if (!portfolio.owner.equals(ownerPk)) return null;
    return sorted[0].pubkey;
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
          let depositIx: TransactionInstruction | null = null;
          let clampedDeposit = 0n;
          if (requestedDeposit > 0n) {
            try {
              const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);
              let ataBalance = 0n;
              try {
                const info = await connection.getTokenAccountBalance(userAta);
                ataBalance = BigInt(info.value.amount);
              } catch {
                ataBalance = 0n; // ATA doesn't exist yet, or a transient RPC hiccup — nothing to deposit
              }
              clampedDeposit = requestedDeposit < ataBalance ? requestedDeposit : ataBalance;
              if (clampedDeposit > 0n) {
                const [vaultPda] = deriveVaultAuthority(programId, slabPk);
                const vaultTokenAta = await getAta(vaultPda, mktConfig.collateralMint, true);
                depositIx = buildIx({
                  programId,
                  keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
                    wallet.publicKey,
                    slabPk,
                    portfolioPk,
                    userAta,
                    vaultTokenAta,
                    WELL_KNOWN.tokenProgram,
                  ]),
                  data: encodeDepositCollateral({ amount: clampedDeposit.toString() }),
                });
              }
            } catch {
              // Best-effort: fall through to init-only. The account still
              // gets created; the user can deposit manually afterward.
              depositIx = null;
              clampedDeposit = 0n;
            }
          }

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

          let sig: string;
          let depositedAmount = 0n;
          if (depositIx) {
            try {
              // FIRST try: InitPortfolio + Deposit in ONE transaction — the
              // portfolio's address is already known (client-generated
              // keypair) before the tx lands, so Deposit can reference it
              // in the same atomic tx.
              sig = await sendV17([...baseInstructions, depositIx], [portfolioKp]);
              depositedAmount = clampedDeposit;
            } catch (combinedErr) {
              // One-tx failed (compute/size limits, wallet simulation, or the
              // program rejecting a same-tx Deposit against a portfolio
              // initialized earlier in that same tx). Fall back to two
              // transactions chained back-to-back — from the caller's POV
              // this is still one "Setting up your account…" action. Account
              // creation must succeed on its own merits; the deposit leg is
              // best-effort on top of it.
              if (process.env.NODE_ENV === "development") {
                console.warn("[useInitUser] combined init+deposit tx failed, falling back to two-step:", combinedErr);
              }
              sig = await sendV17(baseInstructions, [portfolioKp]);
              try {
                sig = await sendV17([depositIx]);
                depositedAmount = clampedDeposit;
              } catch (depositErr) {
                // Account exists; auto-deposit just didn't land. Not fatal —
                // depositedAmount stays 0n on the resolved result so the
                // caller can still prompt a manual deposit, not a scary
                // top-level error.
                if (process.env.NODE_ENV === "development") {
                  console.warn("[useInitUser] follow-up deposit tx failed:", depositErr);
                }
              }
            }
          } else {
            sig = await sendV17(baseInstructions, [portfolioKp]);
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
