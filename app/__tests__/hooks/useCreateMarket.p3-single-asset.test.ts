import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeInitMarket, v17MarketAccountLen } from "@percolatorct/sdk";
import { deriveMarketParams } from "@/lib/market-params";
import { wizardP3Params } from "@/lib/limits/p3-wizard";

vi.mock("@/lib/limits/flags", async (orig) => {
  const real = await orig<typeof import("@/lib/limits/flags")>();
  return { ...real, p3WizardEnabled: vi.fn(() => false) };
});

import {
  buildV17InitMarketArgs,
  DEFAULT_SLAB_SIZE,
  P3_MARKET_ASSET_SLOTS,
  V17_MAX_PORTFOLIO_ASSETS,
  marketAssetSlotsFor,
  slabSizeFor,
  wizardSlabBytes,
} from "@/hooks/useCreateMarket";
import { computeCreateMarketSolCost } from "@/components/create/CostEstimate";

// P3 markets are strictly single-asset: on the P3 FINAL (58e379f1) tag 94
// refuses `max_market_slots != 1` with error 86 VaultLpMultiAssetMarket. The
// wizard must therefore create P3 markets with maxPortfolioAssets = 1 and a
// slab sized for one asset slot. Legacy launches now ALSO allocate one slot (only
// slot 0 is ever used; security review 2026-10-08): the two differ in nothing the
// InitMarket args or the account length carry.
const p3Params = { p3: { juniorAtoms: 1n } };
const legacyParams = {};

describe("every launch creates a single-asset market", () => {
  it("P3 and legacy plans both use maxPortfolioAssets = 1; the 14 is only the program cap", () => {
    expect(P3_MARKET_ASSET_SLOTS).toBe(1);
    expect(marketAssetSlotsFor(p3Params)).toBe(1);
    expect(marketAssetSlotsFor(legacyParams)).toBe(1);
    expect(V17_MAX_PORTFOLIO_ASSETS).toBe(14);
  });

  it("the InitMarket args create() sends carry 1 slot on P3 and on legacy (encoded bytes)", () => {
    const derived = deriveMarketParams(5, 1_000_000_000n, 1_000_000n);
    const base = { initialPriceE6: 1_000_000n, tradingFeeBps: 30 };
    const p3Args = buildV17InitMarketArgs({ ...base, p3: wizardP3Params(true, 1n, 1000) }, derived);
    const legacyArgs = buildV17InitMarketArgs(base, derived);
    expect(p3Args.maxPortfolioAssets).toBe(1);
    expect(legacyArgs.maxPortfolioAssets).toBe(1);
    // Wire: tag u8 then max_portfolio_assets u16 LE.
    const p3Bytes = encodeInitMarket(p3Args);
    const legacyBytes = encodeInitMarket(legacyArgs);
    expect(p3Bytes[1] | (p3Bytes[2] << 8)).toBe(1);
    expect(legacyBytes[1] | (legacyBytes[2] << 8)).toBe(1);
    // The legacy and P3 InitMarket instructions are byte-identical.
    expect(Buffer.from(p3Bytes).equals(Buffer.from(legacyBytes))).toBe(true);
  });

  it("P3 and legacy slabs are both v17MarketAccountLen(1), and a slab given by the caller cannot override it", () => {
    expect(slabSizeFor(p3Params)).toBe(v17MarketAccountLen(1));
    expect(slabSizeFor(legacyParams)).toBe(v17MarketAccountLen(1));
    expect(slabSizeFor(legacyParams)).toBe(DEFAULT_SLAB_SIZE);
    expect(DEFAULT_SLAB_SIZE).toBe(v17MarketAccountLen(1));
    expect(wizardSlabBytes(true)).toBe(v17MarketAccountLen(1));
    expect(wizardSlabBytes(false)).toBe(v17MarketAccountLen(1));
  });

  it("the rent estimate charges the one-slot slab for legacy and P3 alike", () => {
    const p3 = computeCreateMarketSolCost({ p3: true });
    const legacy = computeCreateMarketSolCost();
    const rent = (bytes: number) => ((bytes + 128) * 5080) / 1e9;
    expect(p3.slabRentSol).toBeCloseTo(rent(v17MarketAccountLen(1)), 9);
    expect(legacy.slabRentSol).toBeCloseTo(rent(v17MarketAccountLen(1)), 9);
    // P3 differs by the vault-owned LP portfolio + matcher ctx it also creates, not by the slab.
    expect(legacy.totalSolCost - p3.totalSolCost).toBeCloseTo(
      -(p3.lpPortfolioMatcherRentSol - legacy.lpPortfolioMatcherRentSol),
      9,
    );
  });

  describe("source guards (every sizing site goes through the helper)", () => {
    const hook = readFileSync(resolve(process.cwd(), "hooks/useCreateMarket.ts"), "utf8");
    const wizard = readFileSync(resolve(process.cwd(), "components/create/CreateMarketWizard.tsx"), "utf8");
    const cost = readFileSync(resolve(process.cwd(), "components/create/CostEstimate.tsx"), "utf8");
    const args = readFileSync(resolve(process.cwd(), "lib/create-market-args.ts"), "utf8");

    it("every create path builds InitMarket through the one builder", () => {
      expect(hook.match(/maxPortfolioAssets:\s*[^,\n]+/g) ?? []).toEqual([]);
      expect(args.match(/maxPortfolioAssets:\s*[^,\n]+/g) ?? []).toEqual([
        "maxPortfolioAssets: marketAssetSlotsFor(params)",
      ]);
      expect((hook.match(/buildV17InitMarketArgs\(params, derived\)/g) ?? []).length).toBe(3);
      expect(hook).not.toMatch(/v17InitArgs:\s*InitMarketV17Args\s*=\s*\{/);
    });

    it("no slab allocation falls back to the 14-slot size directly", () => {
      expect(hook).not.toMatch(/params\.slabDataSize \?\? DEFAULT_SLAB_SIZE/);
      expect((hook.match(/slabSizeFor\(params\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
      expect(hook).not.toMatch(/assetGenerationFrontier:\s*BigInt\(V17_MAX_PORTFOLIO_ASSETS\)/);
    });

    it("the Control Room readout and the cost estimate use the P3-aware size", () => {
      expect(wizard).toContain("slabBytes={wizardSlabBytes(p3WizardEnabled())}");
      expect(wizard).toContain("computeCreateMarketSolCost({ p3: p3WizardEnabled() })");
      expect(cost).not.toMatch(/=\s*DEFAULT_SLAB_SIZE;/);
      expect(cost).not.toMatch(/dataSize:\s*DEFAULT_SLAB_SIZE/);
    });
  });
});
