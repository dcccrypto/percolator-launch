/**
 * A stake whose value can't be read (v2.2 first-loss pool with unreadable InsuranceUnits) has
 * `redeemable: null` from useLpPositions. The panel shows a dash for it, and its section total and the
 * panel total are unknown (a dash) too, never a partial sum or "$0.00" (same rule as /stake, #3611).
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LpPosition } from "@/hooks/useLpPositions";
import { LpPositionsPanel } from "@/components/portfolio/LpPositionsPanel";

const base = {
  collateralMint: "", lpMint: "", logoUrl: null, lpBalanceRaw: 1n, lpBalance: 1, totalLpSupply: 0, tvl: null,
  userSharePct: 0, cooldownSlots: 0, cooldownElapsed: true, apr: 0, poolMode: 0, kind: "stake",
} as const;
const known: LpPosition = { ...base, poolAddress: "PoolA", slabAddress: "SlabA", name: "PENGU", symbol: "PENGU", redeemable: 5, redeemableRaw: 5_000_000n };
const unknown: LpPosition = { ...base, poolAddress: "PoolB", slabAddress: "SlabB", name: "SOL", symbol: "SOL", redeemable: null, redeemableRaw: null };
const earn: LpPosition = { ...base, poolAddress: "E", slabAddress: "E", name: "JUP", symbol: "JUP", redeemable: 2.5, redeemableRaw: 2_500_000n, poolMode: 1, kind: "earn", tvl: 0 };

describe("LpPositionsPanel: a stake with an unknown value", () => {
  it("shows a dash for the row, the Stake section total and the panel total", () => {
    render(<LpPositionsPanel positions={[earn, known, unknown]} totalRedeemable={null} loading={false} error={null} />);
    const stake = screen.getByText("Fee staking").closest("section") as HTMLElement;
    const sol = within(stake).getByText("SOL").closest("a") as HTMLElement;
    expect(within(sol).getByText("redeemable").previousElementSibling?.textContent).toBe("—");
    expect(within(stake).getByText("total redeemable").previousElementSibling?.textContent).toBe("—");
    expect(screen.getByText("— total")).toBeTruthy();
    expect(screen.queryByText(/\$NaN|\$5\.00 total|\$7\.50/)).toBeNull();
    // The Vault section is fully known: its own total still shows.
    const vault = screen.getByText("Vault").closest("section") as HTMLElement;
    expect(within(vault).getByText("total redeemable").previousElementSibling?.textContent).toBe("$2.50");
  });

  it("CONTROL: all known values sum as before", () => {
    render(<LpPositionsPanel positions={[earn, known]} totalRedeemable={7.5} loading={false} error={null} />);
    expect(screen.getByText("$7.50 total")).toBeTruthy();
    const stake = screen.getByText("Fee staking").closest("section") as HTMLElement;
    expect(within(stake).getByText("total redeemable").previousElementSibling?.textContent).toBe("$5.00");
  });
});
