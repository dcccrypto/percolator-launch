/**
 * sdk-compat.ts — backward-compatibility stubs for SDK exports removed in beta.29+.
 *
 * TODO(oracle-migration): PushOraclePrice (IX tag 16) and SetOracleAuthority (IX tag 17)
 * were removed from the on-chain program in Phase G (beta.29). The client-side oracle push
 * path in useTrade, useWithdraw, useAdminActions, useCreateMarket, and the mobile API route
 * must be migrated to the server-side oracle advance flow (see /api/oracle/advance-phase).
 * Until that migration is complete, the DEX oracle mode will not push prices inline, which
 * means trades against DEX-oracle markets will fail if the oracle is stale.
 *
 * Reference: IX_TAG comment in beta.32: "16, 17 — removed in v1.0.0-beta.29 (Phase G admin-push oracle removal)"
 */

import { PublicKey } from "@solana/web3.js";

// ------------------------------------------------------------------
// ACCOUNTS_SET_ORACLE_AUTHORITY — was [slab(writable), authority(signer, writable)]
// Stub: empty array causes buildAccountMetas to throw at runtime (length mismatch),
// which surfaces as a clear error rather than a silent wrong transaction.
// ------------------------------------------------------------------
/** @deprecated Removed in beta.29. Migrate to server-side oracle flow. */
export const ACCOUNTS_SET_ORACLE_AUTHORITY: never[] = [];

// ------------------------------------------------------------------
// ACCOUNTS_PUSH_ORACLE_PRICE — was [authority(signer, writable), slab(writable)]
// Stub: empty array.
// ------------------------------------------------------------------
/** @deprecated Removed in beta.29. Migrate to server-side oracle flow. */
export const ACCOUNTS_PUSH_ORACLE_PRICE: never[] = [];

// ------------------------------------------------------------------
// encodeSetOracleAuthority — was IX tag 17
// Stub: returns empty Uint8Array so downstream buildIx doesn't crash on import,
// but the empty ACCOUNTS array will cause buildAccountMetas to throw first.
// ------------------------------------------------------------------
/** @deprecated Removed in beta.29. Migrate to server-side oracle flow. */
export function encodeSetOracleAuthority(_args: { newAuthority: PublicKey }): Uint8Array {
  throw new Error(
    "[sdk-compat] encodeSetOracleAuthority: on-chain instruction removed in beta.29. " +
    "TODO: migrate this callsite to server-side oracle flow (/api/oracle/advance-phase)."
  );
}

// ------------------------------------------------------------------
// encodePushOraclePrice — was IX tag 16
// Stub: throws at call time.
// ------------------------------------------------------------------
/** @deprecated Removed in beta.29. Migrate to server-side oracle flow. */
export function encodePushOraclePrice(_args: {
  priceE6: string | bigint;
  timestamp: string | bigint;
}): Uint8Array {
  throw new Error(
    "[sdk-compat] encodePushOraclePrice: on-chain instruction removed in beta.29. " +
    "TODO: migrate this callsite to server-side oracle flow (/api/oracle/advance-phase)."
  );
}
