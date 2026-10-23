/**
 * A vault whose value can't be determined (two-pot state unreadable or unpriceable; the program
 * refuses 75/77 on it too) is left out of the TVL by name: "—" on its row, a note under the total.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EarnHeader, excludesNote } from "@/components/earn/EarnHeader";
import { VaultRow } from "@/components/earn/VaultRow";
import { buildMarketVaultInfo, computeAggregates } from "@/hooks/useEarnStats";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const unvalued = { tvlAtoms: 0n, cooldownSlots: 0n, found: true, unvalued: true };

describe("an unvalued vault", () => {
  it("carries the flag into the row, which shows — rather than $0.00", () => {
    const info = buildMarketVaultInfo(SLAB, "PERCOLATOR", "Percolator", null, { [SLAB]: unvalued }, new Map());
    expect(info).toMatchObject({ unvalued: true, vaultBalance: 0, hasVault: true });
    render(<VaultRow vault={info} selected={false} userDepositUsd={null} onSelect={() => {}} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("is left out of the total, which names it", () => {
    const valued = buildMarketVaultInfo("A", "SOL", "SOL", null, { A: { tvlAtoms: 45_000_000_000n, cooldownSlots: 0n, found: true } }, new Map());
    const stuck = buildMarketVaultInfo(SLAB, "PERCOLATOR", "Percolator", null, { [SLAB]: unvalued }, new Map());
    expect(computeAggregates([valued, stuck])).toMatchObject({ tvl: 45_000, unvaluedSymbols: ["PERCOLATOR"] });
  });

  it("the header names it under the total", () => {
    render(<EarnHeader stats={{ markets: [], tvl: 378_960, totalOI: 0, maxOI: 0, oiUtilPct: 0, totalInsurance: 0, dailyFeeRevenue: 0, unvaluedSymbols: ["PERCOLATOR"] }} loading={false} />);
    expect(screen.getByTestId("earn-tvl-excludes").textContent).toBe("Excludes 1 vault (PERCOLATOR) that can't be valued right now.");
  });

  it("no note when every vault is valued", () => {
    render(<EarnHeader stats={{ markets: [], tvl: 1, totalOI: 0, maxOI: 0, oiUtilPct: 0, totalInsurance: 0, dailyFeeRevenue: 0, unvaluedSymbols: [] }} loading={false} />);
    expect(screen.queryByTestId("earn-tvl-excludes")).toBeNull();
  });

  it("names up to three, then counts the rest", () => {
    expect(excludesNote(["A", "B"])).toBe("Excludes 2 vaults (A, B) that can't be valued right now.");
    expect(excludesNote(["A", "B", "C", "D", "E"])).toBe("Excludes 5 vaults (A, B, C and 2 more) that can't be valued right now.");
  });
});
