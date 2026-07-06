"use client";

import { useCallback, useState } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  encodeTopUpInsurance,
  encodeUpdateAuthority,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_UPDATE_AUTHORITY,
} from "@percolatorct/sdk";
// oracle-push instructions (IX 16/17) were removed on-chain in Phase G (beta.29).
// setOracleAuthority and pushPrice now throw INLINE_ORACLE_ADMIN_REMOVED_ERROR immediately.
// sdk-compat stubs are no longer imported here.
//
// v17 removals: RenounceAdmin (tag 21), SetRiskThreshold (tag 11), PauseMarket (tag 56),
// UnpauseMarket (tag 58) do not exist in v17. Admin rotation uses UpdateAuthority (tag 32).
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
  // v17 markets carry an empty header ({}); the market authority lives in
  // configV17.marketauth. Dereferencing header.admin on a v17 market throws a
  // TypeError before any tx, so read marketauth first and fall back to the v12
  // header admin. (Mirrors the discovery pattern in useMyMarkets.)
  const admin = (market.configV17?.marketauth ?? market.header?.admin)?.toBase58();
  if (!admin) {
    throw new Error(
      `[${action}] Could not determine the market admin authority. ` +
      `This action is unavailable for this market.`,
    );
  }
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
  // v17 markets have no admin-oracle authority in the v12 MarketConfig shape
  // (market.config is {} on v17, so config.oracleAuthority.toBase58() throws a
  // TypeError before any tx). v17 has no equivalent single admin-oracle key —
  // treat it as unavailable and surface a clear error instead of crashing.
  if (market.configV17) {
    throw new Error(
      `[${action}] The admin-oracle authority is not available on v17 markets. ` +
      `This action is unavailable for this market.`,
    );
  }
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
      // v17: TopUpInsurance (tag 9) is gated on insurance_authority stored in the
      // per-asset AssetOracleProfileV17 at asset_index 0, offset 24.
      // The on-chain program enforces expect_live_authority as the final gate.
      // Note: insurance_authority is in the AssetOracleProfile which is NOT stored in
      // MarketConfig (DiscoveredMarket.config). The on-chain gate handles the check;
      // we do not attempt a client-side pre-flight here to avoid depending on
      // out-of-band profile data not present in DiscoveredMarket.
      setLoading("topUpInsurance");
      try {
        const { getAssociatedTokenAddress, getAssociatedTokenAddressSync } =
          await import("@solana/spl-token");

        // Resolve the collateral mint + vault token account. On v17 the config is
        // {} — collateralMint lives in configV17 and the vault is DERIVED (not
        // stored): vaultAuthority = deriveVaultAuthority(programId, slab), vault
        // token = ATA(mint, vaultAuthority, allowOwnerOffCurve). This mirrors
        // useCloseMarket.ts. v12 markets keep reading config.
        let collateralMint: PublicKey;
        let vaultPubkey: PublicKey;
        if (market.configV17) {
          collateralMint = market.configV17.collateralMint;
          const [vaultAuthority] = deriveVaultAuthority(market.programId, market.slabAddress);
          vaultPubkey = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true);
        } else {
          collateralMint = market.config.collateralMint;
          vaultPubkey = market.config.vaultPubkey;
        }

        const userAta = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);
        const data = encodeTopUpInsurance({ amount: amount.toString() });
        const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
          wallet.publicKey,
          market.slabAddress,
          userAta,
          vaultPubkey,
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

  // v17: RenounceAdmin (tag 21) is removed. Admin rotation uses UpdateAuthority (tag 32)
  // with 3 accounts [currentAuthority(signer), newAuthority(signer/ro), slab(w)].
  // Passing PublicKey.default() as newPubkey effectively burns the admin key.
  const renounceAdmin = useCallback(
    async (market: DiscoveredMarket) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      // PERC-8311: Pre-flight authority check — must be admin to renounce admin role
      requireAdminAuthority(wallet.publicKey, market, "renounceAdmin");
      setLoading("renounceAdmin");
      try {
        // v17: Use UpdateAuthority (tag 32) with new_pubkey = all-zeros (zero pubkey)
        // to effectively burn the admin key. Requires 3 accounts:
        // [currentAuthority(signer), newAuthority, slab(w)]
        const zeroPk = new PublicKey(new Uint8Array(32));
        const data = encodeUpdateAuthority({ newPubkey: zeroPk });
        const keys = buildAccountMetas(ACCOUNTS_UPDATE_AUTHORITY, [
          wallet.publicKey,
          zeroPk,
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

  // v17: SetRiskThreshold (tag 11) is removed — no direct replacement in v17.
  // Use UpdateLiquidationFeePolicy (tag 37) or UpdateMaintenanceFeePolicy (tag 48) for
  // fee/risk policy updates. This stub surfaces a clear error to prevent silent failures.
  const resetRiskGate = useCallback(
    async (_market: DiscoveredMarket) => {
      throw new Error(
        "[resetRiskGate] SetRiskThreshold (tag 11) was removed in v17. " +
        "Use UpdateLiquidationFeePolicy (tag 37) or UpdateMaintenanceFeePolicy (tag 48) " +
        "for risk/fee policy updates on v17 markets.",
      );
    },
    [],
  );

  // v17: PauseMarket (tag 56) is removed — tag 56 is now TopUpInsuranceDomain.
  // v17 does not have a PauseMarket instruction. This stub prevents silent wrong-tag dispatch.
  const pauseMarket = useCallback(
    async (_market: DiscoveredMarket) => {
      throw new Error(
        "[pauseMarket] PauseMarket was removed in v17. Tag 56 is now TopUpInsuranceDomain. " +
        "v17 does not have a market-pause instruction.",
      );
    },
    [],
  );

  // v17: UnpauseMarket (tag 58) is removed — tag 58 is now UpdateFeeRedirectPolicy.
  // v17 does not have an UnpauseMarket instruction. This stub prevents silent wrong-tag dispatch.
  const unpauseMarket = useCallback(
    async (_market: DiscoveredMarket) => {
      throw new Error(
        "[unpauseMarket] UnpauseMarket was removed in v17. Tag 58 is now UpdateFeeRedirectPolicy. " +
        "v17 does not have a market-unpause instruction.",
      );
    },
    [],
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
