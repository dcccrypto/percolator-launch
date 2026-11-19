/**
 * Differential finding: the engine's convert_released_pnl_to_capital_not_atomic first runs
 * release_account_source_credit_liens_if_unneeded_not_atomic when the account records any lien
 * (percolator feat/v22-engine-rc23-2026-10-22 src/v16.rs:25418-25429, #137), BEFORE the lien gate
 * in the core (:25251-25257). A flat account's stale lien therefore does not block tag 28, but the
 * app's convertGate calls it "locked" and quoteConvertible used to return without simulating.
 */
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const slot = {
  domain: 0, sourceClaimMarketId: 1n, sourceClaimBoundNum: 10n * 1_000_000_000_000n, sourceClaimLienedNum: 1n,
  sourceClaimCounterpartyLienedNum: 0n, sourceClaimInsuranceLienedNum: 0n, sourceLienEffectiveReserved: 1n,
  sourceLienCounterpartyBackingNum: 0n, sourceLienInsuranceBackingNum: 0n, sourceLienFeeLastSlot: 0n,
  sourceClaimImpairedNum: 0n, sourceLienImpairedEffectiveReserved: 0n, sourceLienCapitalAtRiskFeeRevenue: 0n,
  sourceLienImpairedCapitalAtRiskFeeRevenue: 0n,
};
const base = { portfolioId: 1n, matcherPositionEpoch: 1n, capital: 100n, pnl: 10n, reservedPnl: 0n, legs: [], sourceDomains: [slot] };

vi.mock("@/lib/v22/layout", () => ({
  parsePortfolio: (d: Uint8Array) => (d[0] === 1 ? base : { ...base, capital: 110n, pnl: 0n, sourceDomains: [] }),
}));

import { quoteConvertible, type QuoteDeps } from "@/lib/convert-released-pnl";

const k = () => PublicKey.unique();
const params = { programId: k(), owner: k(), market: k(), portfolio: k(), portfolioData: new Uint8Array([1]) };

describe("quoteConvertible: flat account with a stale source lien", () => {
  it("simulates tag 28 (the engine releases the lien first) instead of short-circuiting to 'locked'", async () => {
    let calls = 0;
    const deps: QuoteDeps = {
      async simulate() {
        calls++;
        return { err: null, postData: new Uint8Array([2]), rpcFailed: false };
      },
    };
    const q = await quoteConvertible(params, deps);
    expect(calls).toBe(1);
    expect(q.status).toBe("ready");
    if (q.status === "ready") expect(q.convertible).toBe(10n);
  });

  it("if the simulation still answers LockActive, the reason stays 'locked'", async () => {
    const deps: QuoteDeps = {
      async simulate() {
        return { err: { InstructionError: [0, { Custom: 21 }] }, postData: null, rpcFailed: false };
      },
    };
    const q = await quoteConvertible(params, deps);
    expect(q.status === "settling" && q.reason).toBe("locked");
  });
});
