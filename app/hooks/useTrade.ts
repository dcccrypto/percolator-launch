"use client";

import { useCallback, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeTradeCpi,
  encodeKeeperCrank,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_KEEPER_CRANK,
  buildAccountMetas,
  buildIx,
  deriveLpPda,
  derivePythPushOraclePDA,
  WELL_KNOWN,
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
import { useLivePrice } from "@/hooks/useLivePrice";
import { computeLimitPriceE6 } from "@/lib/slippage";

const INLINE_ORACLE_PUSH_REMOVED_ERROR =
  "Inline oracle price push was removed on-chain in beta.29. Migrate this flow to /api/oracle/advance-phase or another server-side oracle publisher before trading as the oracle authority.";

export function useTrade(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, accounts, programId: slabProgramId } = useSlabState();
  const { priceE6: livePriceE6 } = useLivePrice();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const trade = useCallback(
    async (params: { lpIdx: number; userIdx: number; size: bigint; limitPriceE6?: bigint }) => {
      if (inflightRef.current) throw new Error("Trade already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        // Defense-in-depth: refuse to build a tx whose programId is not in
        // our deployed allowlist. See SlabProvider.parseSlab for the primary
        // gate.
        assertKnownProgram(slabProgramId);
        const lpAccount = accounts.find((a) => a.idx === params.lpIdx);
        if (!lpAccount) throw new Error(`LP at index ${params.lpIdx} not found`);

        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const [lpPda] = deriveLpPda(programId, slabPk, params.lpIdx);

        // Slippage protection. The on-chain handler treats limit_price_e6 == 0
        // as a "no limit" sentinel and skips the slippage check entirely
        // (percolator.rs::handle_trade_cpi). Without a real limit, the only
        // remaining defense is the anti-off-market band (~1% by default),
        // leaving the user exposed within that band to a hostile matcher or
        // an in-band MEV race. Derive a non-zero limit from the live mark
        // when the caller omits one. An explicit `limitPriceE6: 0n` from the
        // caller is preserved as an opt-in escape hatch for keeper/bot paths
        // that intentionally skip the check.
        const effectiveLimitPriceE6: bigint =
          params.limitPriceE6 !== undefined
            ? params.limitPriceE6
            : computeLimitPriceE6({ markE6: livePriceE6 ?? 0n, size: params.size });

        // Determine oracle mode using centralised detectOracleMode (oraclePrice.ts).
        // "pyth-pinned" = Pyth feed; "admin" or "hyperp" = use slab as oracle account.
        const oracleMode = detectOracleMode(mktConfig);
        const useAdminOracle = oracleMode !== "pyth-pinned";
        const feedHex = Array.from(mktConfig.indexFeedId.toBytes()).map(b => b.toString(16).padStart(2, "0")).join("");
        const oracleAccount = useAdminOracle ? slabPk : derivePythPushOraclePDA(feedHex)[0];

        const instructions = [];

        // For admin oracle markets where user IS the oracle authority,
        // push a fresh price before cranking (crank needs fresh oracle data).
        // PERC-8328 / GH#1966: NEVER fall back to a hardcoded price — if we can't get
        // a valid, fresh price from the backend, abort the trade entirely. Pushing a
        // fabricated oracle price (e.g. $1) would cause catastrophic mispricing.
        const userIsOracleAuth = useAdminOracle && mktConfig.oracleAuthority.equals(wallet.publicKey);
        if (userIsOracleAuth) {
          throw new Error(INLINE_ORACLE_PUSH_REMOVED_ERROR);
        }

        // Always prepend a permissionless crank before trading
        // Market goes stale after 400 slots (~3 min) — each user tx refreshes it
        // callerIdx=65535 = permissionless, anyone can crank
        const crankIx = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount]),
          data: encodeKeeperCrank({ callerIdx: 65535 }),
        });
        instructions.push(crankIx);

        const tradeIx = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, [
            wallet.publicKey,
            lpAccount.account.owner,
            slabPk,
            WELL_KNOWN.clock,
            oracleAccount,
            lpAccount.account.matcherProgram,
            lpAccount.account.matcherContext,
            lpPda,
          ]),
          data: encodeTradeCpi({ lpIdx: params.lpIdx, userIdx: params.userIdx, size: params.size.toString(), limitPriceE6: effectiveLimitPriceE6.toString() }),
        });
        instructions.push(tradeIx);

        return await sendTx({ connection, wallet, instructions, computeUnits: 600_000 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, accounts, slabAddress, slabProgramId, livePriceE6]
  );

  return { trade, loading, error };
}
