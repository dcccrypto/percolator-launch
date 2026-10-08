/**
 * /create quoted three SOL costs (header "≈ 0.19", Control Room rent 0.237, gate
 * "Need ~0.347") off a hard-coded 6960 lamports/byte. getMinimumBalanceForRentExemption
 * on devnet and mainnet returns (bytes + 128) × 5080, and two real launches cost their
 * creators 0.2249 and 0.2382 SOL, so a wallet holding enough could not launch.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import { computeCreateMarketSolCost } from "@/components/create/CostEstimate";
import { DEFAULT_SLAB_SIZE } from "@/lib/create-market-args";
import { VAULT_LP_MATCHER_CTX_LEN } from "@/lib/limits/constants";

const rpcRent = (bytes: number) => ((bytes + 128) * 5080) / 1e9;

describe("computeCreateMarketSolCost", () => {
  it("matches the RPC rent-exempt minimum for the market account", () => {
    // A launch allocates ONE asset slot: v17MarketAccountLen(1) = 3,675 bytes (was 33,900 at 14 slots).
    expect(DEFAULT_SLAB_SIZE).toBe(3_675);
    // getMinimumBalanceForRentExemption(3675) = (3675 + 128) * 5080 = 19,319,240 on devnet and mainnet
    expect(computeCreateMarketSolCost().slabRentSol).toBeCloseTo(0.01931924, 9);
  });

  it("covers what real launches spent, below the old 0.347 gate", () => {
    // Two real 14-slot launches cost their creators 0.2249 and 0.2382 SOL. A launch now allocates a
    // 3,675-byte market account instead of 33,900, so the same launch costs that much less in rent;
    // the estimate must still cover it.
    const slabSaving = rpcRent(33_900) - rpcRent(3_675);
    const { totalSolCost } = computeCreateMarketSolCost();
    expect(totalSolCost).toBeGreaterThanOrEqual(0.2382 - slabSaving);
    expect(totalSolCost).toBeLessThan(0.3);
  });

  it("charges the 128-byte overhead on every account, not only the market", () => {
    const c = computeCreateMarketSolCost();
    expect(c.tokenAccountRentSol).toBeCloseTo(rpcRent(165) * 3 + rpcRent(82) * 2, 9);
  });

  it("adds the vault-owned LP portfolio and matcher context for P3 launches", () => {
    const delta =
      computeCreateMarketSolCost({ p3: true }).lpPortfolioMatcherRentSol -
      computeCreateMarketSolCost().lpPortfolioMatcherRentSol;
    expect(delta).toBeCloseTo(rpcRent(V17_PORTFOLIO_ACCOUNT_LEN) + rpcRent(VAULT_LP_MATCHER_CTX_LEN), 9);
  });
});

describe("/create header", () => {
  it("quotes the same estimate the launch gate checks", () => {
    const src = readFileSync(join(__dirname, "..", "..", "app/create/page.tsx"), "utf8");
    expect(src).toContain("computeCreateMarketSolCost({ p3: p3WizardEnabled() }).totalSolCost");
    expect(src).not.toContain("0.19 SOL");
  });
});
