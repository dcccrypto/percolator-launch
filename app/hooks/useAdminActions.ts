"use client";

import { useCallback, useState } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  encodeTopUpInsurance,
  encodeUpdateAssetAuthority,
  ASSET_AUTH_KIND,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
  ACCOUNTS_TOPUP_INSURANCE,
} from "@percolatorct/sdk";
import { updateAssetAuthorityKeys, ZERO_PUBKEY } from "@/lib/update-asset-authority-keys";
// oracle-push instructions (IX 16/17) were removed on-chain in Phase G (beta.29).
// setOracleAuthority and pushPrice now throw INLINE_ORACLE_ADMIN_REMOVED_ERROR immediately.
// sdk-compat stubs are no longer imported here.
//
// v17 removals: RenounceAdmin (tag 21), SetRiskThreshold (tag 11), PauseMarket (tag 56),
// UnpauseMarket (tag 58) do not exist in v17. Admin rotation uses UpdateAuthority (tag 32).
import { sendTx } from "@/lib/tx";
import type { DiscoveredMarket } from "@percolatorct/sdk";
import { readAssetMarketId, readAssetControlSeqs, readAssetAdmin } from "@/lib/v18-wire";

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

/** Wait before the second on-chain re-read after a failed burn (lets a just-landed burn show up). */
const BURN_RECHECK_DELAY_MS = 1_500;

/**
 * True when asset 0's `asset_admin` reads as the zero key. Only the current
 * asset_admin can burn it, so a zero key after this wallet's burn attempt means
 * the burn is done. `reads` reads, BURN_RECHECK_DELAY_MS apart. A failed read is
 * indeterminate and counts as "not burned", so the caller keeps its own error.
 */
async function adminKeyBurnedOnChain(
  connection: Pick<Connection, "getAccountInfo">,
  slab: PublicKey,
  reads: number,
): Promise<boolean> {
  for (let i = 0; i < reads; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, BURN_RECHECK_DELAY_MS));
    try {
      const info = await connection.getAccountInfo(slab, "confirmed");
      if (info?.data && readAssetAdmin(new Uint8Array(info.data), 0).equals(ZERO_PUBKEY)) return true;
    } catch {
      // RPC hiccup: indeterminate, keep the original error.
    }
  }
  return false;
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
        // v18: TopUpInsurance (tag 55) binds asset 0's market_id + authority_epoch
        // (CAS, current value) + a strictly-increasing one-shot intentId on the
        // shared insurance_top_up lane. The lane watermark is not exposed by the
        // SDK parsers, so on an EXISTING market we use the current slot as a
        // monotonic one-shot nonce (strictly-increasing across calls). NOTE: this
        // admin top-up path is not on-chain-verified in this migration.
        const tuiInfo = await connection.getAccountInfo(market.slabAddress, "confirmed");
        if (!tuiInfo?.data) throw new Error("Market account not found");
        const tuiData = new Uint8Array(tuiInfo.data);
        const data = encodeTopUpInsurance({
          marketId: readAssetMarketId(tuiData, 0),
          intentId: BigInt(await connection.getSlot("confirmed")),
          authorityEpoch: readAssetControlSeqs(tuiData, 0).authorityEpoch,
          amount: amount.toString(),
        });
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

  // "Burn admin key" — renounce the CREATOR's admin authority.
  //
  // The creator's admin key is asset 0's `asset_admin` (a wallet they hold),
  // NOT `WrapperConfigV17.marketauth`. StakeInitPool rotates `marketauth` to the
  // keyless stake-pool PDA at creation, so the creator never holds it — the old
  // code targeted marketauth via UpdateAuthority (tag 32) and ALWAYS failed on a
  // completed market ("not the market admin (stake-pool PDA)"). The correct
  // instruction is UpdateAssetAuthority (tag 65, kind=AssetAdmin, asset 0,
  // new=0), gated by `asset_admin`, which the creator can sign — mirrors the
  // keeper-cosign oracle-delegate flow. On-chain, only ASSET_ADMIN is burnable
  // to the zero pubkey.
  const renounceAdmin = useCallback(
    async (market: DiscoveredMarket) => {
      if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
      setLoading("renounceAdmin");
      try {
        const zeroPk = ZERO_PUBKEY;
        const info = await connection.getAccountInfo(market.slabAddress, "confirmed");
        if (!info?.data) throw new Error("Market account not found");
        const slabData = new Uint8Array(info.data);

        // Pre-flight: burn-admin is gated on asset 0's `asset_admin` (creator),
        // not marketauth. Check the connected wallet holds it before prompting a
        // doomed signature (the on-chain program is the final gate).
        const assetAdmin = readAssetAdmin(slabData, 0).toBase58();
        const walletB58 = wallet.publicKey.toBase58();
        if (assetAdmin === zeroPk.toBase58()) {
          throw new Error("The admin key is already burned.");
        }
        if (assetAdmin !== walletB58) {
          throw new Error(
            `[renounceAdmin] Connected wallet (${walletB58.slice(0, 8)}…) is not the market admin ` +
            `(${assetAdmin.slice(0, 8)}…). Connect the creator/admin wallet to burn the admin key.`,
          );
        }

        // v18: UpdateAssetAuthority is CAS-bound to asset 0's market_id +
        // authority_epoch (live current values), same as the keeper-cosign flow.
        const marketId = readAssetMarketId(slabData, 0);
        const authorityEpoch = readAssetControlSeqs(slabData, 0).authorityEpoch;
        const data = encodeUpdateAssetAuthority({
          assetIndex: 0,
          marketId,
          kind: ASSET_AUTH_KIND.AssetAdmin,
          newPubkey: zeroPk,
          authorityEpoch,
        });
        // A burn needs only the current admin's signature; the zero key rides
        // along read-only (see lib/update-asset-authority-keys.ts).
        const keys = updateAssetAuthorityKeys(wallet.publicKey, zeroPk, market.slabAddress);
        const ix = buildIx({ programId: market.programId, keys, data });
        try {
          return await sendTx({ connection, wallet, instructions: [ix] });
        } catch (err) {
          // A burn that LANDED can still come back as an error from the send path
          // (seen on devnet: Phantom approved, the tx landed with SUCCESS, and the
          // drawer toasted "User rejected the request."). The burn is idempotent in
          // its end state, so ask the chain before reporting a failure: a zero
          // asset_admin means it is done (null = burned, signature unknown). A
          // pre-sign refusal never opened the wallet, so it gets one read, no wait.
          const preSign = (err as { name?: unknown } | null)?.name === "SimulationRefusal";
          if (await adminKeyBurnedOnChain(connection, market.slabAddress, preSign ? 1 : 2)) return null;
          throw err;
        }
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
