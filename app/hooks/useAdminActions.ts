"use client";

import { useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeSetOraclePriceCap,
  encodeTopUpInsurance,
  encodeRenounceAdmin,
  encodeCreateInsuranceMint,
  encodeSetRiskThreshold,
  encodePauseMarket,
  encodeUnpauseMarket,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
  deriveInsuranceLpMint,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_UPDATE_ADMIN,
  ACCOUNTS_CREATE_INSURANCE_MINT,
  ACCOUNTS_SET_RISK_THRESHOLD,
  ACCOUNTS_PAUSE_MARKET,
  ACCOUNTS_UNPAUSE_MARKET,
} from "@percolator/core";
import { sendTx } from "@/lib/tx";
import type { DiscoveredMarket } from "@percolator/core";

export function useAdminActions() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [loading, setLoading] = useState<string | null>(null);

  const setOracleAuthority = useCallback(
    async (market: DiscoveredMarket, newAuthority: string) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      setLoading("setOracleAuthority");
      try {
        const data = encodeSetOracleAuthority({ newAuthority: new PublicKey(newAuthority) });
        const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
          wallet.publicKey,
          market.slabAddress,
        ]);
        const ix = buildIx({ programId: market.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } finally {
        setLoading(null);
      }
    },
    [connection, wallet],
  );

  const pushPrice = useCallback(
    async (market: DiscoveredMarket, priceE6: string) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      setLoading("pushPrice");
      try {
        const instructions = [];
        const now = Math.floor(Date.now() / 1000);

        // First: disable the price cap so the price can jump directly to target
        // (SetOraclePriceCap uses same accounts as SetOracleAuthority — admin + slab)
        const capData = encodeSetOraclePriceCap({ maxChangeE2bps: 0n });
        const capKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
          wallet.publicKey,
          market.slabAddress,
        ]);
        instructions.push(buildIx({ programId: market.programId, keys: capKeys, data: capData }));

        // Then: push the actual target price
        const pushData = encodePushOraclePrice({ priceE6, timestamp: now.toString() });
        const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
          wallet.publicKey,
          market.slabAddress,
        ]);
        instructions.push(buildIx({ programId: market.programId, keys: pushKeys, data: pushData }));

        // Finally: re-enable the price cap (1% = 10000 e2bps)
        const reCapData = encodeSetOraclePriceCap({ maxChangeE2bps: BigInt(10_000) });
        instructions.push(buildIx({ programId: market.programId, keys: capKeys, data: reCapData }));

        return await sendTx({ connection, wallet, instructions, computeUnits: 400_000 });
      } finally {
        setLoading(null);
      }
    },
    [connection, wallet],
  );

  const topUpInsurance = useCallback(
    async (market: DiscoveredMarket, amount: bigint) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      setLoading("topUpInsurance");
      try {
        const { getAssociatedTokenAddress } = await import("@solana/spl-token");
        const userAta = await getAssociatedTokenAddress(market.config.collateralMint, wallet.publicKey);
        const data = encodeTopUpInsurance({ amount: amount.toString() });
        const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
          wallet.publicKey,
          market.slabAddress,
          userAta,
          market.config.vaultPubkey,
          TOKEN_PROGRAM_ID,
        ]);
        const ix = buildIx({ programId: market.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } finally {
        setLoading(null);
      }
    },
    [connection, wallet],
  );

  const createInsuranceMint = useCallback(
    async (market: DiscoveredMarket) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      setLoading("createInsuranceMint");
      try {
        const [vaultAuth] = deriveVaultAuthority(market.programId, market.slabAddress);
        const [mintPda] = deriveInsuranceLpMint(market.programId, market.slabAddress);
        const data = encodeCreateInsuranceMint();
        const keys = buildAccountMetas(ACCOUNTS_CREATE_INSURANCE_MINT, [
          wallet.publicKey,
          market.slabAddress,
          mintPda,
          vaultAuth,
          market.config.collateralMint,
          SystemProgram.programId,
          TOKEN_PROGRAM_ID,
          SYSVAR_RENT_PUBKEY,
          wallet.publicKey,
        ]);
        const ix = buildIx({ programId: market.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } finally {
        setLoading(null);
      }
    },
    [connection, wallet],
  );

  const renounceAdmin = useCallback(
    async (market: DiscoveredMarket) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      setLoading("renounceAdmin");
      try {
        const data = encodeRenounceAdmin();
        const keys = buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [
          wallet.publicKey,
          market.slabAddress,
        ]);
        const ix = buildIx({ programId: market.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } finally {
        setLoading(null);
      }
    },
    [connection, wallet],
  );

  const resetRiskGate = useCallback(
    async (market: DiscoveredMarket) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      setLoading("resetRiskGate");
      try {
        const data = encodeSetRiskThreshold({ newThreshold: 0n });
        const keys = buildAccountMetas(ACCOUNTS_SET_RISK_THRESHOLD, [
          wallet.publicKey,
          market.slabAddress,
        ]);
        const ix = buildIx({ programId: market.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } finally {
        setLoading(null);
      }
    },
    [connection, wallet],
  );

  const pauseMarket = useCallback(
    async (market: DiscoveredMarket) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      setLoading("pauseMarket");
      try {
        const data = encodePauseMarket();
        const keys = buildAccountMetas(ACCOUNTS_PAUSE_MARKET, [
          wallet.publicKey,
          market.slabAddress,
        ]);
        const ix = buildIx({ programId: market.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } finally {
        setLoading(null);
      }
    },
    [connection, wallet],
  );

  const unpauseMarket = useCallback(
    async (market: DiscoveredMarket) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      setLoading("unpauseMarket");
      try {
        const data = encodeUnpauseMarket();
        const keys = buildAccountMetas(ACCOUNTS_UNPAUSE_MARKET, [
          wallet.publicKey,
          market.slabAddress,
        ]);
        const ix = buildIx({ programId: market.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } finally {
        setLoading(null);
      }
    },
    [connection, wallet],
  );

  return {
    loading,
    setOracleAuthority,
    pushPrice,
    topUpInsurance,
    createInsuranceMint,
    renounceAdmin,
    resetRiskGate,
    pauseMarket,
    unpauseMarket,
  };
}
