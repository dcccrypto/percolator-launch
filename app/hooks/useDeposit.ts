"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
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
  isV17Account,
  V17_PORTFOLIO_ACCOUNT_LEN,
  deriveVaultAuthority,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { isBlockedSlab } from "@/lib/blocklist";
import { getPortfolioRawSnapshot, makePortfolioScanKey } from "@/lib/userAccountScan";
import { findOwnerPortfolio } from "@/lib/owner-portfolio";
import { useSlabState } from "@/components/providers/SlabProvider";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { humanizeError, UserFacingError, userFacingMessage } from "@/lib/errorMessages";
import { fetchPortfolioIdentity } from "@/lib/v18-wire";
import { assertDepositWithinBalance, readTokenBalance } from "@/lib/deposit-guard";

// v17 portfolio account size = SDK V17_PORTFOLIO_ACCOUNT_LEN (9347). MUST be the full length:
// InitPortfolio reallocs up to 9347 and adds NO lamports, so funding rent for a smaller size
// leaves the account below rent-exempt and InitPortfolio fails with InsufficientFundsForRent.
const V17_PORTFOLIO_ACCOUNT_SIZE = V17_PORTFOLIO_ACCOUNT_LEN;

/**
 * The user's v17 portfolio on this market (lib/owner-portfolio.ts). `null` ONLY
 * when the scan found none — an RPC failure throws PortfolioLookupError, so a
 * 429 can never make this flow create a second portfolio (M-4).
 */
const findV17Portfolio = findOwnerPortfolio;

export function useDeposit(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, programId: slabProgramId, params: slabParams, wrapperConfigV17, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);
  // #2323: the delayed refreshSlab below outlives the component if the user
  // navigates within its 2s window — the callback then fires against an unmounted
  // tree. Track pending timers so the unmount effect can clear them.
  const pendingTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const t of pendingTimersRef.current) clearTimeout(t);
      pendingTimersRef.current = [];
    },
    [],
  );

  const deposit = useCallback(
    async (params: { userIdx: number; amount: bigint; accountExists?: boolean; portfolioPk?: PublicKey }) => {
      if (inflightRef.current) throw new Error("Deposit already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        // Two errors, not one: the message resolver maps "Wallet not connected" to "Wallet locked", so the old
        // combined string told a connected user to unlock their wallet while the market was still loading.
        if (!wallet.publicKey) throw new Error("Wallet not connected");
        if (!mktConfig || !slabProgramId) throw new Error("Market not loaded");
        // Retired/blocklisted market: the market pages are hidden from
        // discovery, but the trade page still renders on a direct URL — and a
        // deposit into a retired market can be UNRECOVERABLE (CATE died that
        // way under an older engine, where the bankruptcy hlock rejected every
        // withdrawal; on the current engine the hlock only gates LP-backing and
        // insurance withdrawals, but a retired market can still strand funds). Withdrawals stay ungated — money must always be able to
        // leave — but no new money gets in.
        if (isBlockedSlab(slabAddress)) {
          throw new UserFacingError(
            "This market has been retired — deposits are disabled. Existing funds can still be withdrawn where the market allows it.",
          );
        }
        // Defense-in-depth: refuse to build a tx whose programId is not in
        // our deployed allowlist, even if SlabProvider somehow surfaced one
        // (e.g. a future code path mutates programId post-load, or a future
        // page mounts this hook without going through SlabProvider's gate).
        assertKnownProgram(slabProgramId);

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
        // Latency: SlabProvider having parsed a v17 config for this slab
        // proves the market exists on THIS connection's network AND settles
        // the layout question — both purposes of this refetch. Only pay the
        // round-trip when the provider hasn't loaded yet (first render).
        if (wrapperConfigV17 == null) {
          try {
            const slabInfo = await connection.getAccountInfo(slabPk);
            if (slabInfo === null) {
              throw new UserFacingError(
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
        }

        // Wallet-balance guard (after the network check above, so a wrong-network
        // slab reports "switch networks" rather than a bogus 0 balance): never build (or send the InitPortfolio tx
        // below for) a deposit larger than what the wallet holds. Withdraw
        // rejects over-amounts up front; deposit must too instead of relying on
        // the chain's `require_token_balance` revert. A failed balance READ
        // (null) is not blocking — the chain still validates.
        assertDepositWithinBalance(params.amount, await readTokenBalance(connection, userAta));

        const instructions: TransactionInstruction[] = [];

        // v17 vs v12 deposit path diverge on the account list shape.
        // v17: [owner, market, portfolio, sourceToken, vaultToken, tokenProgram] (6 accounts, no clock)
        // v12: [owner, market, userAta, vault, tokenProgram, clock] (6 accounts, has clock)
        //
        // M9: Prefer the already-loaded SlabProvider state (`wrapperConfigV17`)
        // over re-detecting the layout from the fresh `slabData` refetch above —
        // that refetch is best-effort (a transient RPC blip leaves `slabData`
        // undefined) and used to silently default `isV17` to `false`, building
        // a v12-shaped deposit tx (wrong account list + wrong instruction
        // encoding) against a v17 slab. Only fall back to detecting from
        // `slabData` when SlabProvider hasn't parsed a v17 config for this slab
        // (e.g. the very first render, before SlabProvider's initial load).
        const isV17 = wrapperConfigV17 != null || (slabData ? isV17Account(slabData) : false);

        if (isV17) {
          // v17: derive vault authority PDA to build the vault token ATA.
          // vaultPda is program PDA (off the ed25519 curve) → allowOwnerOffCurve=true,
          // else spl-token throws TokenOwnerOffCurveError.
          const [vaultPda] = deriveVaultAuthority(programId, slabPk);
          const vaultTokenAta = await getAta(vaultPda, mktConfig.collateralMint, true);
          // ── v17 deposit path ────────────────────────────────────────────────
          // Portfolio accounts in v17 are standalone program-owned accounts.
          // We must find or create the user's portfolio account.

          // Latency: the ATA-existence check and the portfolio lookup are
          // independent — run them concurrently instead of serially. The
          // portfolio lookup itself is usually FREE: the shared scan store
          // (useUserAccount and friends) already knows the pubkey, which
          // never changes for a (wallet, market) pair; the program scan is
          // only the cold-start fallback.
          const [ataExists, resolvedPortfolioPk] = await Promise.all([
            getAccount(connection, userAta).then(() => true, () => false),
            (async () => {
              if (params.portfolioPk) return params.portfolioPk;
              const snap = getPortfolioRawSnapshot(
                makePortfolioScanKey(programId, slabAddress, wallet.publicKey!),
              );
              if (snap && snap.portfolio.owner.equals(wallet.publicKey!)) return snap.pubkey;
              return findV17Portfolio(connection, programId, slabPk, wallet.publicKey!);
            })(),
          ]);

          // Ensure user ATA exists (prevents token transfer failure)
          if (!ataExists) {
            instructions.push(
              createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                userAta,
                wallet.publicKey,
                mktConfig.collateralMint,
              ),
            );
          }

          // Find or create the user's portfolio account.
          let portfolioPk = resolvedPortfolioPk;

          if (!portfolioPk && !params.accountExists) {
            // No portfolio for this user — create one and run InitPortfolio (tag 1).
            // InitPortfolio account list: [owner(signer,w), market(w), portfolio(w)]
            // The portfolio is a client-generated keypair that the program will initialize.
            const portfolioKp = Keypair.generate();
            portfolioPk = portfolioKp.publicKey;

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
            instructions.push(createPortfolioIx, initPortfolioIx);
            // Send portfolio init in a separate tx so Deposit can reference the initialized account.
            const initSig = await sendTx({ connection, wallet, instructions: [createPortfolioIx, initPortfolioIx], signers: [portfolioKp] });
            if (process.env.NODE_ENV === "development") {
              console.log("[useDeposit] v17 portfolio initialized:", portfolioPk.toBase58(), "sig:", initSig);
            }
            instructions.length = 0; // Clear — we sent the init above; deposit is a separate tx.
          }

          if (!portfolioPk) {
            throw new Error("v17: Could not find or create portfolio account. Please try again.");
          }

          // v18 Deposit (tag 3): binds the portfolio's live portfolioId + the
          // per-portfolio matcher-sequence CAS watermark (`expectedSequence`),
          // read live off the (just-initialized or existing) portfolio account.
          const depId = await fetchPortfolioIdentity(connection, portfolioPk);
          instructions.push(
            buildIx({
              programId,
              keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
                wallet.publicKey,
                slabPk,
                portfolioPk,
                userAta,
                vaultTokenAta,
                WELL_KNOWN.tokenProgram,
              ]),
              data: encodeDepositCollateral({
                portfolioId: depId.portfolioId,
                expectedSequence: depId.matcherSequence,
                amount: params.amount.toString(),
              }),
            }),
          );
        } else {
          // ── v12 legacy deposit path ──────────────────────────────────────────
          let resolvedUserIdx = params.userIdx;

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
                resolvedUserIdx = slabAccounts.length;

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

                const naf = slabParams?.newAccountFee ?? 0n;
                const mid = slabParams?.minInitialDeposit ?? 0n;
                const accountFee = naf > mid ? naf : mid;
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
              if (process.env.NODE_ENV === "development") {
                console.warn("[useDeposit] sub-account check failed:", parseErr);
              }
            }
          }

          // v12 DepositCollateral (tag 3) — LEGACY path for the abandoned v12
          // slabs (no v18 portfolio account exists, so portfolioId/expectedSequence
          // don't apply). Unreachable on the v18 playground; kept only so the old
          // wire still type-checks. 0n placeholders — a v12 slab would reject this,
          // which is correct (those markets are abandoned).
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
                portfolioId: 0n,
                expectedSequence: 0n,
                amount: params.amount.toString(),
              }),
            }),
          );
        }

        const sig = await sendTx({ connection, wallet, instructions, selfHeal: { programId, market: slabPk } });

        // Force immediate slab re-read so balance updates without waiting for
        // the next poll cycle (which can be up to 30 s when WS is active).
        refreshSlab?.();
        pendingTimersRef.current.push(setTimeout(() => refreshSlab?.(), 2000));
        return sig;
      } catch (e) {
        setError(userFacingMessage(e) ?? humanizeError(e instanceof Error ? e.message : String(e)));
        throw e;
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAddress, slabProgramId, wrapperConfigV17, refreshSlab],
  );

  return { deposit, loading, error };
}
