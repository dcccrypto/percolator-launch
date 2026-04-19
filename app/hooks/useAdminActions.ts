"use client";

import { useCallback, useState } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  encodeTopUpInsurance,
  encodeRenounceAdmin,
  encodeSetRiskThreshold,
  encodePauseMarket,
  encodeUnpauseMarket,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_UPDATE_ADMIN,
  ACCOUNTS_SET_RISK_THRESHOLD,
  ACCOUNTS_PAUSE_MARKET,
  ACCOUNTS_UNPAUSE_MARKET,
} from "@percolatorct/sdk";
// oracle-push instructions (IX 16/17) were removed on-chain in Phase G (beta.29).
// setOracleAuthority and pushPrice now throw INLINE_ORACLE_ADMIN_REMOVED_ERROR immediately.
// sdk-compat stubs are no longer imported here.
import { sendTx } from "@/lib/tx";
import type { DiscoveredMarket } from "@percolatorct/sdk";

const INLINE_ORACLE_ADMIN_REMOVED_ERROR =
  "Admin oracle update instructions were removed on-chain in beta.29. Migrate this action to the server-side oracle flow before using it.";

/**
 * PERC-8311 — Authority pre-flight helpers.
 *
 * These checks verify the connected wallet holds the required role BEFORE building
 * any privileged instruction. The on-chain program still enforces authority as the
 * final gate, but these client-side checks prevent:
 *  - Confusing "sign a doomed transaction" prompts for non-admin users
 *  - Unnecessary signature requests that will always fail on-chain
 *  - Phishing surface where users are tricked into signing predictably-failing txs
 */

/**
 * Asserts the connected wallet is the market admin.
 * Throws a descriptive error if it isn't, so the caller can surface it to the UI.
 */
function requireAdminAuthority(
  walletKey: PublicKey,
  market: DiscoveredMarket,
  action: string,
): void {
  const admin = market.header.admin.toBase58();
  const wallet = walletKey.toBase58();
  if (admin !== wallet) {
    throw new Error(
      `[${action}] Connected wallet (${wallet.slice(0, 8)}…) is not the market admin ` +
      `(${admin.slice(0, 8)}…). Connect the admin wallet to perform this action.`,
    );
  }
}

/**
 * Asserts the connected wallet is the market oracle authority.
 * Throws a descriptive error if it isn't.
 */
function requireOracleAuthority(
  walletKey: PublicKey,
  market: DiscoveredMarket,
  action: string,
): void {
  const oracle = market.config.oracleAuthority.toBase58();
  const wallet = walletKey.toBase58();
  if (oracle !== wallet) {
    throw new Error(
      `[${action}] Connected wallet (${wallet.slice(0, 8)}…) is not the oracle authority ` +
      `(${oracle.slice(0, 8)}…). Connect the oracle authority wallet to perform this action.`,
    );
  }
}

export function useAdminActions() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [loading, setLoading] = useState<string | null>(null);

  const setOracleAuthority = useCallback(
    async (market: DiscoveredMarket, _newAuthority: string) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      // PERC-8311: Pre-flight authority check — must be current oracle authority
      requireOracleAuthority(wallet.publicKey, market, "setOracleAuthority");
      throw new Error(INLINE_ORACLE_ADMIN_REMOVED_ERROR);
    },
    [wallet],
  );

  const pushPrice = useCallback(
    async (market: DiscoveredMarket, _priceE6: string) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      // PERC-8311: Pre-flight authority check — must be oracle authority to push prices
      requireOracleAuthority(wallet.publicKey, market, "pushPrice");
      throw new Error(INLINE_ORACLE_ADMIN_REMOVED_ERROR);
    },
    [wallet],
  );

  const topUpInsurance = useCallback(
    async (market: DiscoveredMarket, amount: bigint) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      // topUpInsurance is permissioned by token balance, not admin role — no authority pre-check needed.
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

  // Insurance LP mint creation moved to percolator-stake program.
  const createInsuranceMint = useCallback(
    async (_market: DiscoveredMarket) => {
      throw new Error("Insurance LP mint creation has moved to the percolator-stake program");
    },
    [],
  );

  const renounceAdmin = useCallback(
    async (market: DiscoveredMarket) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      // PERC-8311: Pre-flight authority check — must be admin to renounce admin role
      requireAdminAuthority(wallet.publicKey, market, "renounceAdmin");
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
      // PERC-8311: Pre-flight authority check — must be admin to reset risk gate
      requireAdminAuthority(wallet.publicKey, market, "resetRiskGate");
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
      // PERC-8311: Pre-flight authority check — must be admin to pause a market
      requireAdminAuthority(wallet.publicKey, market, "pauseMarket");
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
      // PERC-8311: Pre-flight authority check — must be admin to unpause a market
      requireAdminAuthority(wallet.publicKey, market, "unpauseMarket");
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
