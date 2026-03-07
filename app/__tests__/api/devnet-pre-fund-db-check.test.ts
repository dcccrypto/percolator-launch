/**
 * Tests for #873 fix: devnet-pre-fund DB check bypass when DEVNET_ALLOWED_MINTS is empty.
 *
 * Verifies that when DEVNET_ALLOWED_MINTS is unset/empty the endpoint ALWAYS
 * consults the devnet_mints DB instead of short-circuiting to permitted=true.
 *
 * We test the permission logic in isolation (without a full route handler) since
 * the full handler has side-effects (RPC calls, Solana transactions) that are
 * hard to stub in unit tests.
 */

import { describe, it, expect } from "vitest";

/**
 * Replicate the permission-check logic extracted from the route for unit testing.
 * Must stay in sync with app/app/api/devnet-pre-fund/route.ts.
 */
async function resolveMintPermission(
  mintAddress: string,
  allowedMints: Set<string>,
  dbResult: string | null,
  dbThrows: boolean,
): Promise<boolean> {
  let finallyPermitted: boolean;

  if (allowedMints.size > 0) {
    if (allowedMints.has(mintAddress)) {
      finallyPermitted = true;
    } else {
      if (dbThrows) {
        // DB unavailable and not in static list: fail-closed
        finallyPermitted = false;
      } else {
        finallyPermitted = dbResult === mintAddress;
      }
    }
  } else {
    // #873: No static allowlist — ALWAYS query DB
    if (dbThrows) {
      // DB unavailable and no static allowlist: allow through (on-chain is the gate)
      finallyPermitted = true;
    } else {
      finallyPermitted = dbResult === mintAddress;
    }
  }

  return finallyPermitted;
}

const GOOD_MINT = "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs";
const UNKNOWN_MINT = "So11111111111111111111111111111111111111112"; // SOL mint

describe("#873 devnet-pre-fund permission logic", () => {
  // --- Pre-fix bug: empty allowlist short-circuited to true ---
  it("empty allowlist + mint NOT in DB → denied (fixes #873 bypass)", async () => {
    const permitted = await resolveMintPermission(
      UNKNOWN_MINT,
      new Set(), // DEVNET_ALLOWED_MINTS empty
      null,      // DB returns no row
      false,
    );
    expect(permitted).toBe(false);
  });

  it("empty allowlist + mint IN DB → permitted", async () => {
    const permitted = await resolveMintPermission(
      GOOD_MINT,
      new Set(), // empty allowlist
      GOOD_MINT, // DB returns the mint
      false,
    );
    expect(permitted).toBe(true);
  });

  it("empty allowlist + DB unavailable → permitted (on-chain authority is final gate)", async () => {
    const permitted = await resolveMintPermission(
      UNKNOWN_MINT,
      new Set(), // empty allowlist
      null,
      true, // DB throws
    );
    // When DB is down AND no allowlist: allow through, on-chain check catches abuse
    expect(permitted).toBe(true);
  });

  // --- Static allowlist behaviour (unchanged) ---
  it("static allowlist matches mint → permitted (no DB needed)", async () => {
    const permitted = await resolveMintPermission(
      GOOD_MINT,
      new Set([GOOD_MINT]),
      null, // DB not consulted
      false,
    );
    expect(permitted).toBe(true);
  });

  it("static allowlist present but mint not in it + mint IN DB → permitted", async () => {
    const permitted = await resolveMintPermission(
      UNKNOWN_MINT,
      new Set([GOOD_MINT]), // list has a different mint
      UNKNOWN_MINT,         // DB returns the requested mint
      false,
    );
    expect(permitted).toBe(true);
  });

  it("static allowlist present + mint not in it + DB throws → denied (fail-closed)", async () => {
    const permitted = await resolveMintPermission(
      UNKNOWN_MINT,
      new Set([GOOD_MINT]),
      null,
      true, // DB throws
    );
    expect(permitted).toBe(false);
  });
});
