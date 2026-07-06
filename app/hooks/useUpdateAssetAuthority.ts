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

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeUpdateAssetAuthority,
  ASSET_AUTH_KIND,
  type AssetAuthKind,
  ACCOUNTS_UPDATE_AUTHORITY,
  buildAccountMetas,
  buildIx,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { assertKnownProgram } from "@/lib/programAllowlist";

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
  /** New pubkey to install. Zero = burn (only valid for AssetAdmin on asset != 0). */
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
        const data = encodeUpdateAssetAuthority({
          assetIndex: params.assetIndex,
          kind: params.kind,
          newPubkey,
        });
        // v17: UpdateAssetAuthority (tag 65) uses the 3-account shape of ACCOUNTS_UPDATE_AUTHORITY:
        // [0] currentAuthority (signer) — asset_admin or current holder of the authority
        // [1] newAuthority (signer or read-only) — the new pubkey being installed
        // [2] slab (writable)
        const keys = buildAccountMetas(ACCOUNTS_UPDATE_AUTHORITY, [
          wallet.publicKey,
          newPubkey,
          slabPk,
        ]);
        const ix = buildIx({ programId: params.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
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
