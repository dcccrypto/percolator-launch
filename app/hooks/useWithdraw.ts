"use client";

import { useCallback, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getBackendUrl } from "@/lib/config";
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
} from "@percolator/core";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";

export function useWithdraw(slabAddress: string) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { config: mktConfig, programId: slabProgramId } = useSlabState();
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

        // Determine if admin oracle mode
        const hasAdminOracle = !mktConfig.oracleAuthority.equals(PublicKey.default);
        const feedHex = Array.from(mktConfig.indexFeedId.toBytes()).map(b => b.toString(16).padStart(2, "0")).join("");
        const isZeroFeed = feedHex === "0".repeat(64);
        const useAdminOracle = hasAdminOracle || isZeroFeed;
        const oracleAccount = useAdminOracle ? slabPk : derivePythPushOraclePDA(feedHex)[0];

        const instructions = [];

        // If user is oracle authority, push price first
        const userIsOracleAuth = useAdminOracle && mktConfig.oracleAuthority.equals(wallet.publicKey);
        if (userIsOracleAuth) {
          let priceE6 = mktConfig.authorityPriceE6 ?? 1_000_000n;
          try {
            const resp = await fetch(`${getBackendUrl()}/prices/markets`);
            if (resp.ok) {
              const prices = await resp.json();
              const entry = prices[slabAddress];
              if (entry?.priceE6) priceE6 = BigInt(entry.priceE6);
            }
          } catch { /* use existing */ }
          if (priceE6 <= 0n) priceE6 = 1_000_000n;
          instructions.push(buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [wallet.publicKey, slabPk]),
            data: encodePushOraclePrice({ priceE6, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
          }));
        }

        // Always prepend permissionless crank before withdraw
        // Market goes stale after 400 slots (~3 min)
        instructions.push(buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount]),
          data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }),
        }));

        instructions.push(buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
            wallet.publicKey, slabPk, mktConfig.vaultPubkey, userAta, vaultPda, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, oracleAccount,
          ]),
          data: encodeWithdrawCollateral({ userIdx: params.userIdx, amount: params.amount.toString() }),
        }));

        return await sendTx({ connection, wallet, instructions, computeUnits: 300_000 });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAddress, slabProgramId]
  );

  return { withdraw, loading, error };
}
