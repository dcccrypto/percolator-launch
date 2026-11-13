// @vitest-environment node
/**
 * Tests for network guard in /api/mobile/create-market (GH#1950).
 *
 * The endpoint uses an allowlist approach: only NEXT_PUBLIC_DEFAULT_NETWORK === "devnet"
 * is accepted. All other values (mainnet, staging, unset) must be rejected with 403.
 */

import { describe, it, expect } from "vitest";

/**
 * Mirror of the network guard logic in route.ts.
 * Returns null if allowed, or an error message if denied.
 */
function checkNetworkGuard(network: string | undefined): string | null {
  if (network !== "devnet") {
    return (
      "Mobile create-market is only available on devnet. " +
      `Current network: ${network ?? "unset"}.`
    );
  }
  return null;
}

describe("create-market network guard (GH#1950)", () => {
  it("allows devnet", () => {
    expect(checkNetworkGuard("devnet")).toBeNull();
  });

  it("blocks mainnet", () => {
    expect(checkNetworkGuard("mainnet")).toMatch(/only available on devnet/);
    expect(checkNetworkGuard("mainnet")).toMatch(/mainnet/);
  });

  it("blocks undefined / unset env var", () => {
    expect(checkNetworkGuard(undefined)).toMatch(/only available on devnet/);
    expect(checkNetworkGuard(undefined)).toMatch(/unset/);
  });

  it("blocks staging env", () => {
    expect(checkNetworkGuard("staging")).toMatch(/only available on devnet/);
  });

  it("blocks empty string", () => {
    expect(checkNetworkGuard("")).toMatch(/only available on devnet/);
  });

  it("is case-sensitive — Devnet (capital D) is rejected", () => {
    expect(checkNetworkGuard("Devnet")).toMatch(/only available on devnet/);
  });

  it("is case-sensitive — DEVNET (all caps) is rejected", () => {
    expect(checkNetworkGuard("DEVNET")).toMatch(/only available on devnet/);
  });
});
