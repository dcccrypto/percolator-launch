/**
 * PoC + regression — /api/stats must apply the same phantom-OI suppression as
 * /api/markets when summing protocol-wide open interest.
 *
 * /api/markets zeroes a market's OI when it's phantom (no accounts / dust vault)
 * via isPhantomOpenInterest + computeDisplayOiUsd. /api/stats' merged-rows path
 * sums total_open_interest_usd directly, so a market shown as $0 OI in the list
 * still inflates the protocol-wide OI stat. The helpers are the documented single
 * source of truth (markets/route.ts) — stats just wasn't using them.
 */
import { describe, it, expect } from "vitest";
import { isPhantomOpenInterest, MIN_VAULT_FOR_OI } from "@/lib/phantom-oi";
import { computeDisplayOiUsd } from "@/lib/oi-display";

type Row = {
  total_open_interest_usd: number | null;
  total_open_interest: number | null;
  total_accounts: number | null;
  vault_balance: number;
};

// A phantom market: carries stale OI USD but has no accounts and a dust vault.
const phantom: Row = { total_open_interest_usd: 5_000, total_open_interest: 123, total_accounts: 0, vault_balance: 0 };
// A real market: accounts + a funded vault.
const real: Row = { total_open_interest_usd: 10_000, total_open_interest: 456, total_accounts: 5, vault_balance: MIN_VAULT_FOR_OI };

describe("stats phantom-OI suppression", () => {
  it("raw summation over-counts a phantom market (the bug)", () => {
    const rawSum = [phantom, real].reduce((s, m) => s + (m.total_open_interest_usd ?? 0), 0);
    expect(rawSum).toBe(15_000); // phantom's stale $5k is wrongly included
  });

  it("applying isPhantomOpenInterest + computeDisplayOiUsd excludes it (the fix)", () => {
    const fixedSum = [phantom, real].reduce((s, m) => {
      const isPhantom = isPhantomOpenInterest(m.total_accounts, m.vault_balance);
      const oi = computeDisplayOiUsd(m.total_open_interest_usd, isPhantom, m.total_open_interest);
      return s + (oi ?? 0);
    }, 0);
    expect(fixedSum).toBe(10_000); // phantom suppressed to 0, only the real market counts
  });

  it("the phantom market is individually suppressed to 0, the real one is unchanged", () => {
    expect(computeDisplayOiUsd(phantom.total_open_interest_usd, isPhantomOpenInterest(phantom.total_accounts, phantom.vault_balance), phantom.total_open_interest)).toBe(0);
    expect(computeDisplayOiUsd(real.total_open_interest_usd, isPhantomOpenInterest(real.total_accounts, real.vault_balance), real.total_open_interest)).toBe(10_000);
  });
});
