"use client";

import { useCallback, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeWithdrawCollateral,
  encodePermissionlessCrank,
  CrankAction,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
  isV17Account,
  parsePortfolioV17,
} from "@percolatorct/sdk";
// TODO(oracle-migration): encodePushOraclePrice/ACCOUNTS_PUSH_ORACLE_PRICE removed in beta.29.
// The DEX oracle inline push path needs to migrate to /api/oracle/advance-phase.
import {
  encodePushOraclePrice,
  ACCOUNTS_PUSH_ORACLE_PRICE,
} from "@/lib/sdk-compat";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";
import { detectOracleMode } from "@/lib/oraclePrice";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { humanizeError } from "@/lib/errorMessages";

const INLINE_ORACLE_PUSH_REMOVED_ERROR =
  "Inline oracle price push was removed on-chain in beta.29. Migrate this flow to /api/oracle/advance-phase or another server-side oracle publisher before withdrawing as the oracle authority.";

export function useWithdraw(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, wrapperConfigV17, programId: slabProgramId, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const withdraw = useCallback(
    async (params: { userIdx: number; amount: bigint }) => {
      if (inflightRef.current) throw new Error("Withdrawal already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        // Defense-in-depth: refuse to build a tx whose programId is not in
        // our deployed allowlist. See SlabProvider.parseSlab for the primary
        // gate; this hook is a second line so unknown-program slabs cannot
        // produce a wallet-signed withdrawal CPI under any bypass scenario.
        assertKnownProgram(slabProgramId);

        // P-CRITICAL-3: Validate network before withdrawal
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
        const [vaultPda] = deriveVaultAuthority(programId, slabPk);

        // Determine oracle mode using centralised detectOracleMode (oraclePrice.ts).
        // "pyth-pinned" = Pyth feed; "admin" or "hyperp" = use slab as oracle account.
        const oracleMode = detectOracleMode({ ...mktConfig, oracleModeByte: wrapperConfigV17?.oracleMode });
        const useAdminOracle = oracleMode !== "pyth-pinned";
        const feedHex = Array.from(mktConfig.indexFeedId.toBytes()).map(b => b.toString(16).padStart(2, "0")).join("");
        const oracleAccount = useAdminOracle ? slabPk : derivePythPushOraclePDA(feedHex)[0];

        const instructions = [];

        // If user is oracle authority, push price first.
        // PERC-8328 / GH#1966: NEVER fall back to a hardcoded price — if we can't get
        // a valid, fresh price from the backend, abort the withdrawal entirely. Pushing a
        // fabricated oracle price (e.g. $1) would cause catastrophic mispricing.
        const userIsOracleAuth = useAdminOracle && mktConfig.oracleAuthority.equals(wallet.publicKey);
        if (userIsOracleAuth) {
          throw new Error(INLINE_ORACLE_PUSH_REMOVED_ERROR);
        }

        // Fetch slab data to detect v17 vs v12 layout.
        let slabDataForLayout: Uint8Array | null = null;
        try {
          const slabInfo = await connection.getAccountInfo(slabPk);
          if (slabInfo?.data) slabDataForLayout = new Uint8Array(slabInfo.data);
        } catch { /* fall through — layout detection best-effort */ }

        const isV17 = slabDataForLayout ? isV17Account(slabDataForLayout) : false;
        // Set when the v17 path prepends a crank — bumps the CU budget below.
        let v17CrankIncluded = false;

        if (isV17) {
          // ── v17 withdraw path ─────────────────────────────────────────────
          // v17 Withdraw (tag 4): [owner(signer,w), market(w), portfolio(w), destToken(w), vaultToken(w), vaultAuthority, tokenProgram]
          // No clock, no oracle. crank is NOT prepended (v17 Withdraw is standalone).
          // vaultPda is a program PDA (off-curve) → allowOwnerOffCurve=true (else TokenOwnerOffCurveError)
          const vaultTokenAta = await getAta(vaultPda, mktConfig.collateralMint, true);

          // Find the user's portfolio account.
          const V17_MAGIC_BYTES = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
          let portfolioPk: PublicKey | null = null;
          let portfolioData: Buffer | null = null;
          try {
            // Mutable owner (SDK PF_OWNER_OFF) is at offset 116, NOT offset 80
            // (offset 80 is provenanceOwner — IMMUTABLE). MintPositionNft moves the
            // mutable owner to the escrow PDA on wrap but leaves provenance pointing
            // at the original wallet, so filtering on 80 would still match a wrapped
            // (NFT-escrowed) portfolio here.
            const portfolioAccounts = await connection.getProgramAccounts(programId, {
              filters: [
                { memcmp: { offset: 0, bytes: V17_MAGIC_BYTES.toString("base64"), encoding: "base64" } },
                { memcmp: { offset: 16, bytes: slabPk.toBase58() } },
                { memcmp: { offset: 116, bytes: wallet.publicKey.toBase58() } },
              ],
            });
            if (portfolioAccounts.length > 0) {
              const d = portfolioAccounts[0].account.data;
              const candidateData = d instanceof Buffer ? d : Buffer.from(d);
              // Defense-in-depth: re-verify the mutable owner actually matches after
              // fetch — memcmp filters are advisory server-side; don't trust blindly.
              try {
                const candidatePf = parsePortfolioV17(candidateData);
                if (candidatePf.owner.equals(wallet.publicKey)) {
                  portfolioPk = portfolioAccounts[0].pubkey;
                  portfolioData = candidateData;
                }
              } catch { /* leave portfolioPk/portfolioData unset — falls through below */ }
            }
          } catch { /* fall through — portfolio lookup is best-effort */ }

          if (!portfolioPk) {
            throw new Error("v17: No portfolio account found for this wallet. Please deposit first to create your portfolio.");
          }

          // Over-withdraw pre-check (defense-in-depth). The DepositWithdrawCard UI
          // already blocks amount > capital, but this guards direct/other callers
          // and turns a confusing on-chain failure into a clear message.
          //
          // NOTE: we can only bound against TOTAL capital here. When a position is
          // open the true free (unreserved) collateral is lower — computing the
          // exact reserved margin requires the engine's margin math, so the
          // on-chain program remains the source of truth for that case (it rejects
          // with "insufficient margin" if the withdrawal would under-collateralize
          // the open position). This check never blocks a valid withdrawal; it only
          // catches the unambiguous "more than the whole account" case early.
          let hasActiveLegs = false;
          if (portfolioData) {
            try {
              const portfolio = parsePortfolioV17(portfolioData);
              hasActiveLegs = portfolio.legs.some((l) => l.active);
              if (params.amount > portfolio.capital) {
                throw new Error(
                  "Withdrawal amount exceeds your account balance. Reduce the amount and try again.",
                );
              }
            } catch (checkErr) {
              // Re-throw our own validation error; ignore parse failures (best-effort).
              if (
                checkErr instanceof Error &&
                checkErr.message.startsWith("Withdrawal amount exceeds")
              ) {
                throw checkErr;
              }
            }
          }

          // With an OPEN POSITION the program must value the portfolio at fresh
          // state before releasing margin — a standalone withdraw rejects with
          // StaleData (code 19) unless something cranked recently. Trades solve
          // this by prepending PermissionlessCrank(FeeSweep) in the same tx
          // (see useTrade), which is why "close, then withdraw" worked while a
          // plain withdraw said "market data is stale". Mirror the trade flow
          // exactly: crank only when the portfolio has active legs (cranking an
          // empty portfolio returns EngineNonProgress 0x16 and aborts the tx).
          if (hasActiveLegs && portfolioPk) {
            v17CrankIncluded = true;
            const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [
              wallet.publicKey, slabPk, portfolioPk,
            ]);
            // For Pyth mode, append oracle feed account as tail (same as useTrade)
            if (!useAdminOracle) {
              crankKeys.push({ pubkey: oracleAccount, isSigner: false, isWritable: false });
            }
            instructions.push(buildIx({
              programId,
              keys: crankKeys,
              data: encodePermissionlessCrank({ action: CrankAction.FeeSweep, assetIndex: 0, nowSlot: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }),
            }));
          }

          instructions.push(buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
              wallet.publicKey, slabPk, portfolioPk, userAta, vaultTokenAta, vaultPda, WELL_KNOWN.tokenProgram,
            ]),
            data: encodeWithdrawCollateral({ amount: params.amount.toString() }),
          }));
        } else {
          // ── v12 legacy withdraw path ─────────────────────────────────────
          // Always prepend permissionless crank before withdraw.
          // v17: encodePermissionlessCrank replaces encodeKeeperCrank (fundingRateE9 hardcoded 0n).
          instructions.push(buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount]),
            data: encodePermissionlessCrank({ action: CrankAction.FeeSweep, assetIndex: 0, nowSlot: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }),
          }));

          // v12 withdraw: [owner(signer,w), market(w), vault(w), destToken(w), vaultAuthority, tokenProgram, clock, oracle]
          // NOTE: ACCOUNTS_WITHDRAW_COLLATERAL in the v17 SDK is the 7-account v17 shape.
          // The v12 shape has 8 accounts (adds clock + oracle). Build metas manually for v12.
          instructions.push(buildIx({
            programId,
            keys: [
              { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
              { pubkey: slabPk, isSigner: false, isWritable: true },
              { pubkey: mktConfig.vaultPubkey, isSigner: false, isWritable: true },
              { pubkey: userAta, isSigner: false, isWritable: true },
              { pubkey: vaultPda, isSigner: false, isWritable: false },
              { pubkey: WELL_KNOWN.tokenProgram, isSigner: false, isWritable: false },
              { pubkey: WELL_KNOWN.clock, isSigner: false, isWritable: false },
              { pubkey: oracleAccount, isSigner: false, isWritable: false },
            ],
            data: encodeWithdrawCollateral({ userIdx: params.userIdx, amount: params.amount.toString() }),
          }));
        }

        // 600k CU when the v17 crank rides along (matches useTrade's
        // crank+trade budget); all pre-existing paths keep the original 300k.
        const sig = await sendTx({ connection, wallet, instructions, computeUnits: v17CrankIncluded ? 600_000 : 300_000 });
        // Force immediate slab re-read so balance updates without waiting for the next poll.
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
    [connection, wallet, mktConfig, slabAddress, slabProgramId, refreshSlab]
  );

  return { withdraw, loading, error };
}
