"use client";

/**
 * useUpdateAssetAuthority — v17 per-asset authority rotation.
 *
 * Encodes UpdateAssetAuthority (tag 65) which rotates one of the five per-asset
 * authority kinds: Insurance, AssetAdmin, BackingBucket, Oracle, InsuranceOperator.
 *
 * Wire: tag(1) + asset_index(u16) + kind(u8) + new_pubkey[32] = 36 bytes.
 * Accounts: [marketauth/asset_admin (signer, writable), slab (writable)].
 *
 * Gated by the asset's own asset_admin (can rotate any) or by the current
 * holder of that authority (self-rotation). Isolated to the given asset_index.
 *
 * SECURITY NOTE: Rotating Insurance authority for asset 0 to the zero pubkey
 * effectively locks insurance — confirm the intent before submitting.
 * Asset admin can force-rotate any key INCLUDING the insurance authority PDA
 * held by the stake program (see stake threat model for the second-mover escape hatch).
 */

import { errorText } from "@/lib/error-text";
import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeUpdateAssetAuthority,
  ASSET_AUTH_KIND,
  type AssetAuthKind,
  buildIx,
} from "@percolatorct/sdk";
import { updateAssetAuthorityKeys } from "@/lib/update-asset-authority-keys";
import { sendTx } from "@/lib/tx";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { readAssetMarketId, readAssetControlSeqs } from "@/lib/v18-wire";

export { ASSET_AUTH_KIND };
export type { AssetAuthKind };

export interface UpdateAssetAuthorityParams {
  /** Slab (market group) address */
  slabAddress: string;
  /** Program ID that owns the slab */
  programId: PublicKey;
  /** Asset index (0 = primary asset) */
  assetIndex: number;
  /** Authority kind — use ASSET_AUTH_KIND constants */
  kind: AssetAuthKind;
  /** New pubkey to install. Zero = burn (only AssetAdmin may be burned; the admin alone signs). */
  newPubkey: string;
}

export function useUpdateAssetAuthority() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateAssetAuthority = useCallback(
    async (params: UpdateAssetAuthorityParams): Promise<string> => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !wallet.signTransaction) {
          throw new Error("Wallet not connected");
        }
        assertKnownProgram(params.programId);

        let newPubkey: PublicKey;
        try {
          newPubkey = new PublicKey(params.newPubkey);
        } catch {
          throw new Error(`Invalid new authority pubkey: ${params.newPubkey}`);
        }

        const slabPk = new PublicKey(params.slabAddress);
        // v18: UpdateAssetAuthority (tag 65) binds the asset's market_id and is
        // CAS-bound to that asset's authority_epoch lane — both live-read from the
        // market account, authority_epoch passed as the CURRENT value (not +1).
        const slabInfo = await connection.getAccountInfo(slabPk, "confirmed");
        if (!slabInfo?.data) throw new Error("Market account not found");
        const slabData = new Uint8Array(slabInfo.data);
        const data = encodeUpdateAssetAuthority({
          assetIndex: params.assetIndex,
          marketId: readAssetMarketId(slabData, params.assetIndex),
          kind: params.kind,
          newPubkey,
          authorityEpoch: readAssetControlSeqs(slabData, params.assetIndex).authorityEpoch,
        });
        // UpdateAssetAuthority (tag 65) accounts:
        // [0] currentAuthority (signer) — asset_admin or current holder of the authority
        // [1] newAuthority — co-signs for a non-zero key; read-only for a burn to 0
        // [2] slab (writable)
        const keys = updateAssetAuthorityKeys(wallet.publicKey, newPubkey, slabPk);
        const ix = buildIx({ programId: params.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } catch (e) {
        const msg = errorText(e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet],
  );

  return { updateAssetAuthority, loading, error };
}
