/**
 * sdk-compat.ts — backward-compatibility stubs for SDK exports removed in beta.29+.
 *
 * PushOraclePrice (IX tag 16) and SetOracleAuthority (IX tag 17) were removed from the
 * on-chain program in Phase G (beta.29). There is no client-side replacement: v17+ markets
 * configure the oracle in InitMarket and the keeper pushes the mark. The only remaining
 * caller is useCreateMarket's legacy (non-v17) admin-oracle branch, which these stubs make
 * fail loudly instead of sending a transaction the program would reject.
 *
 * Reference: IX_TAG comment in beta.32: "16, 17 — removed in v1.0.0-beta.29 (Phase G admin-push oracle removal)"
 */

import { PublicKey } from "@solana/web3.js";

// ------------------------------------------------------------------
// ACCOUNTS_SET_ORACLE_AUTHORITY — was [slab(writable), authority(signer, writable)]
// Stub: empty array causes buildAccountMetas to throw at runtime (length mismatch),
// which surfaces as a clear error rather than a silent wrong transaction.
// ------------------------------------------------------------------
/** @deprecated Removed in beta.29; no replacement (v17+ configures the oracle in InitMarket). */
export const ACCOUNTS_SET_ORACLE_AUTHORITY: never[] = [];

// ------------------------------------------------------------------
// ACCOUNTS_PUSH_ORACLE_PRICE — was [authority(signer, writable), slab(writable)]
// Stub: empty array.
// ------------------------------------------------------------------
/** @deprecated Removed in beta.29; no replacement (v17+ configures the oracle in InitMarket). */
export const ACCOUNTS_PUSH_ORACLE_PRICE: never[] = [];

// ------------------------------------------------------------------
// encodeSetOracleAuthority — was IX tag 17
// Stub: returns empty Uint8Array so downstream buildIx doesn't crash on import,
// but the empty ACCOUNTS array will cause buildAccountMetas to throw first.
// ------------------------------------------------------------------
/** @deprecated Removed in beta.29; no replacement (v17+ configures the oracle in InitMarket). */
export function encodeSetOracleAuthority(_args: { newAuthority: PublicKey }): Uint8Array {
  throw new Error(
    "[sdk-compat] encodeSetOracleAuthority: on-chain instruction removed in beta.29. " +
    "v17+ markets configure the oracle in InitMarket; this legacy path has no replacement."
  );
}

// ------------------------------------------------------------------
// encodePushOraclePrice — was IX tag 16
// Stub: throws at call time.
// ------------------------------------------------------------------
/** @deprecated Removed in beta.29; no replacement (v17+ configures the oracle in InitMarket). */
export function encodePushOraclePrice(_args: {
  priceE6: string | bigint;
  timestamp: string | bigint;
}): Uint8Array {
  throw new Error(
    "[sdk-compat] encodePushOraclePrice: on-chain instruction removed in beta.29. " +
    "v17+ markets configure the oracle in InitMarket; this legacy path has no replacement."
  );
}
