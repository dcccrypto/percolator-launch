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

const INLINE_ORACLE_PUSH_REMOVED_ERROR =
  "Inline oracle price push was removed on-chain in beta.29. Migrate this flow to /api/oracle/advance-phase or another server-side oracle publisher before withdrawing as the oracle authority.";

export function useWithdraw(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, programId: slabProgramId, refresh: refreshSlab } = useSlabState();
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
        const oracleMode = detectOracleMode(mktConfig);
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

        if (isV17) {
          // ── v17 withdraw path ─────────────────────────────────────────────
          // v17 Withdraw (tag 4): [owner(signer,w), market(w), portfolio(w), destToken(w), vaultToken(w), vaultAuthority, tokenProgram]
          // No clock, no oracle. crank is NOT prepended (v17 Withdraw is standalone).
          // vaultPda is a program PDA (off-curve) → allowOwnerOffCurve=true (else TokenOwnerOffCurveError)
          const vaultTokenAta = await getAta(vaultPda, mktConfig.collateralMint, true);

          // Find the user's portfolio account.
          const V17_MAGIC_BYTES = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
          let portfolioPk: PublicKey | null = null;
          try {
            const portfolioAccounts = await connection.getProgramAccounts(programId, {
              filters: [
                { memcmp: { offset: 0, bytes: V17_MAGIC_BYTES.toString("base64"), encoding: "base64" } },
                { memcmp: { offset: 16, bytes: slabPk.toBase58() } },
                { memcmp: { offset: 80, bytes: wallet.publicKey.toBase58() } },
              ],
            });
            if (portfolioAccounts.length > 0) {
              portfolioPk = portfolioAccounts[0].pubkey;
            }
          } catch { /* fall through */ }

          if (!portfolioPk) {
            throw new Error("v17: No portfolio account found for this wallet. Please deposit first to create your portfolio.");
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

        const sig = await sendTx({ connection, wallet, instructions, computeUnits: 300_000 });
        // Force immediate slab re-read so balance updates without waiting for the next poll.
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
    [connection, wallet, mktConfig, slabAddress, slabProgramId, refreshSlab]
  );

  return { withdraw, loading, error };
}
