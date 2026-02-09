"use client";

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  encodeTradeCpi,
  encodeKeeperCrank,
  encodePushOraclePrice,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas,
  buildIx,
  deriveLpPda,
  derivePythPushOraclePDA,
  WELL_KNOWN,
} from "@percolator/core";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";
import { getBackendUrl } from "@/lib/config";

export function useTrade(slabAddress: string) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { config: mktConfig, accounts, programId: slabProgramId } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trade = useCallback(
    async (params: { lpIdx: number; userIdx: number; size: bigint }) => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        const lpAccount = accounts.find((a) => a.idx === params.lpIdx);
        if (!lpAccount) throw new Error(`LP at index ${params.lpIdx} not found`);

        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const [lpPda] = deriveLpPda(programId, slabPk, params.lpIdx);

        // Determine if this is an admin-oracle market:
        // oracleAuthority != default means an admin has been set (regardless of feedId)
        const hasAdminOracle = !mktConfig.oracleAuthority.equals(PublicKey.default);
        const feedHex = Array.from(mktConfig.indexFeedId.toBytes()).map(b => b.toString(16).padStart(2, "0")).join("");
        const isZeroFeed = feedHex === "0".repeat(64);
        // Use slab as oracle account when admin oracle is set OR feed is all zeros
        const useAdminOracle = hasAdminOracle || isZeroFeed;
        const oracleAccount = useAdminOracle ? slabPk : derivePythPushOraclePDA(feedHex)[0];

        const instructions = [];

        // For admin oracle markets where user IS the oracle authority,
        // push a fresh price before cranking (crank needs fresh oracle data)
        const userIsOracleAuth = useAdminOracle && mktConfig.oracleAuthority.equals(wallet.publicKey);
        if (userIsOracleAuth) {
          // Fetch current price from backend or use last known
          let priceE6 = mktConfig.authorityPriceE6 ?? 1_000_000n;
          try {
            const resp = await fetch(`${getBackendUrl()}/prices/markets`);
            if (resp.ok) {
              const prices = await resp.json();
              const entry = prices[slabAddress];
              if (entry?.priceE6) priceE6 = BigInt(entry.priceE6);
            }
          } catch { /* use existing price */ }
          if (priceE6 <= 0n) priceE6 = 1_000_000n;

          const pushIx = buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [wallet.publicKey, slabPk]),
            data: encodePushOraclePrice({
              priceE6: priceE6,
              timestamp: BigInt(Math.floor(Date.now() / 1000)),
            }),
          });
          instructions.push(pushIx);
        }

        // Always prepend a permissionless crank before trading
        // Market goes stale after 400 slots (~3 min) — each user tx refreshes it
        // callerIdx=65535 = permissionless, anyone can crank
        const crankIx = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount]),
          data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }),
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
          data: encodeTradeCpi({ lpIdx: params.lpIdx, userIdx: params.userIdx, size: params.size.toString() }),
        });
        instructions.push(tradeIx);

        return await sendTx({ connection, wallet, instructions, computeUnits: 600_000 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, accounts, slabAddress, slabProgramId]
  );

  return { trade, loading, error };
}
