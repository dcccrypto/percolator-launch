"use client";

import { useCallback, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
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
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";

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
        // push a fresh price before cranking (crank needs fresh oracle data).
        // PERC-8328 / GH#1966: NEVER fall back to a hardcoded price — if we can't get
        // a valid, fresh price from the backend, abort the trade entirely. Pushing a
        // fabricated oracle price (e.g. $1) would cause catastrophic mispricing.
        const userIsOracleAuth = useAdminOracle && mktConfig.oracleAuthority.equals(wallet.publicKey);
        if (userIsOracleAuth) {
          // Fetch the authoritative price from the backend. Fail hard if unavailable.
          let priceE6: bigint;
          try {
            const resp = await fetch(`/api/prices/markets`);
            if (!resp.ok) throw new Error(`Price fetch failed: HTTP ${resp.status}`);
            const prices = await resp.json();
            const entry = prices[slabAddress];
            if (!entry?.priceE6) throw new Error("No price available for this market from backend");
            priceE6 = BigInt(entry.priceE6);
          } catch (fetchErr) {
            // Do NOT fall back to a hardcoded price — abort to prevent mispricing.
            throw new Error(
              `Cannot push oracle price: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}. ` +
              `Retry when the price service is available.`
            );
          }
          if (priceE6 <= 0n) {
            throw new Error(`Invalid oracle price: ${priceE6}. Price must be positive. Aborting to prevent mispricing.`);
          }

          // Use on-chain slot time instead of client Date.now() to avoid clock drift
          // between client and validator causing signature verification failures
          let oracleTimestamp: bigint;
          try {
            const slot = await connection.getSlot("confirmed");
            const blockTime = await connection.getBlockTime(slot);
            oracleTimestamp = BigInt(blockTime ?? Math.floor(Date.now() / 1000));
          } catch {
            // Fallback to client time if RPC fails
            oracleTimestamp = BigInt(Math.floor(Date.now() / 1000));
          }

          const pushIx = buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [wallet.publicKey, slabPk]),
            data: encodePushOraclePrice({
              priceE6: priceE6,
              timestamp: oracleTimestamp,
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
