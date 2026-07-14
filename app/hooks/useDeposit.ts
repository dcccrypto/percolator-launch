"use client";

import { useCallback, useRef, useState } from "react";
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
  parsePortfolioV17,
  V17_PORTFOLIO_ACCOUNT_LEN,
  deriveVaultAuthority,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { getPortfolioRawSnapshot, isLpPortfolio, makePortfolioScanKey } from "@/lib/userAccountScan";
import { useSlabState } from "@/components/providers/SlabProvider";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { humanizeError } from "@/lib/errorMessages";

// v17 portfolio account size = SDK V17_PORTFOLIO_ACCOUNT_LEN (9347). MUST be the full length:
// InitPortfolio reallocs up to 9347 and adds NO lamports, so funding rent for a smaller size
// leaves the account below rent-exempt and InitPortfolio fails with InsufficientFundsForRent.
const V17_PORTFOLIO_ACCOUNT_SIZE = V17_PORTFOLIO_ACCOUNT_LEN;

/**
 * Find the user's v17 portfolio account for a given market.
 * v17 portfolios are standalone accounts (not embedded in the slab bitmap).
 * We scan getProgramAccounts filtered by owner-program + data magic to find
 * the user's portfolio for this market.
 *
 * Returns null if no portfolio exists yet.
 */
async function findV17Portfolio(
  connection: Parameters<typeof import("@solana/web3.js")["Connection"]["prototype"]["getProgramAccounts"]>[0] extends never ? never : import("@solana/web3.js").Connection,
  programId: PublicKey,
  marketPk: PublicKey,
  ownerPk: PublicKey,
): Promise<PublicKey | null> {
  try {
    // V17 magic bytes at offset 0: 0x5045524356313600 in LE = [0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]
    const V17_MAGIC_BYTES = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: V17_MAGIC_BYTES.toString("base64"), encoding: "base64" } },
        // marketGroupId is at HEADER_LEN(16) in the portfolio = offset 16
        { memcmp: { offset: 16, bytes: marketPk.toBase58() } },
        // Mutable owner (SDK PF_OWNER_OFF) is at offset 116, NOT offset 80
        // (offset 80 is provenanceOwner — IMMUTABLE). MintPositionNft moves the
        // mutable owner to the escrow PDA on wrap but leaves provenance pointing
        // at the original wallet, so filtering on 80 would still match a wrapped
        // (NFT-escrowed) portfolio here.
        { memcmp: { offset: 116, bytes: ownerPk.toBase58() } },
      ],
    });
    // Drop the market's LP portfolio BEFORE the sort/pick below — CRITICAL:
    // a market CREATOR depositing on their own market must create/top up
    // THEIR OWN portfolio, never the LP (the LP's owner == the creator's
    // wallet). See isLpPortfolio's doc comment.
    const nonLpAccounts = accounts.filter(({ account }) => !isLpPortfolio(account.data));
    if (nonLpAccounts.length === 0) return null;
    // M10: getProgramAccounts doesn't guarantee stable ordering across RPC
    // nodes/calls. If more than one account ever matches this owner+market
    // filter, picking an arbitrary array element can select a DIFFERENT
    // portfolio than useWithdraw.ts / useUserAccount.ts pick for the exact
    // same wallet+market — deposit, withdraw, and display would silently
    // disagree about which account holds the user's funds. Sort
    // deterministically by pubkey so every caller converges on the same one.
    const sorted = [...nonLpAccounts].sort((a, b) => a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()));
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

export function useDeposit(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, programId: slabProgramId, params: slabParams, wrapperConfigV17, refresh: refreshSlab } = useSlabState();
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
        }

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
          // vaultPda is a program PDA (off the ed25519 curve) → allowOwnerOffCurve=true,
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

          // v17 Deposit (tag 3): [owner(signer,w), market(w), portfolio(w), sourceToken(w), vaultToken(w), tokenProgram]
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
              data: encodeDepositCollateral({ amount: params.amount.toString() }),
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

          // v12 DepositCollateral (tag 3)
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
        }

        const sig = await sendTx({ connection, wallet, instructions });

        // Force immediate slab re-read so balance updates without waiting for
        // the next poll cycle (which can be up to 30 s when WS is active).
        refreshSlab();
        setTimeout(() => refreshSlab(), 2000);
        return sig;
      } catch (e) {
        setError(humanizeError(e instanceof Error ? e.message : String(e)));
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
