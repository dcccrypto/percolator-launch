"use client";

import { useCallback, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeWithdrawCollateral,
  encodeKeeperCrank,
  encodePushOraclePrice,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";
import { detectOracleMode } from "@/lib/oraclePrice";

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
            oracleTimestamp = BigInt(Math.floor(Date.now() / 1000));
          }

          instructions.push(buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [wallet.publicKey, slabPk]),
            data: encodePushOraclePrice({ priceE6, timestamp: oracleTimestamp }),
          }));
        }

        // Always prepend permissionless crank before withdraw
        // Market goes stale after 400 slots (~3 min)
        instructions.push(buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount]),
          data: encodeKeeperCrank({ callerIdx: 65535 }),
        }));

        instructions.push(buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
            wallet.publicKey, slabPk, mktConfig.vaultPubkey, userAta, vaultPda, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, oracleAccount,
          ]),
          data: encodeWithdrawCollateral({ userIdx: params.userIdx, amount: params.amount.toString() }),
        }));

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
