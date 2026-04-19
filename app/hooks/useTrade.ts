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

const INLINE_ORACLE_PUSH_REMOVED_ERROR =
  "Inline oracle price push was removed on-chain in beta.29. Migrate this flow to /api/oracle/advance-phase or another server-side oracle publisher before trading as the oracle authority.";

export function useTrade(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, accounts, programId: slabProgramId } = useSlabState();
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
        const lpAccount = accounts.find((a) => a.idx === params.lpIdx);
        if (!lpAccount) throw new Error(`LP at index ${params.lpIdx} not found`);

        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const [lpPda] = deriveLpPda(programId, slabPk, params.lpIdx);

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
          data: encodeTradeCpi({ lpIdx: params.lpIdx, userIdx: params.userIdx, size: params.size.toString(), limitPriceE6: params.limitPriceE6?.toString() ?? "0" }),
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
    [connection, wallet, mktConfig, accounts, slabAddress, slabProgramId]
  );

  return { trade, loading, error };
}
