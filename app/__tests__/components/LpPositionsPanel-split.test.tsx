/**
 * Portfolio "Earn and stake positions" panel, split into Vault (Earn / LP-vault deposits) and
 * Stake (stake-pool positions) sections (#2871).
 *
 * The split must follow where a position LIVES — `LpPosition.kind`, set by useLpPositions — not
 * `poolMode`. A stake pool can be poolMode 1 (trading LP); it is still a stake-pool position,
 * managed on /stake, and must not land under Vault or deep-link to /earn/<slab>.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LpPosition } from "@/hooks/useLpPositions";
import { LpPositionsPanel } from "@/components/portfolio/LpPositionsPanel";

const base = {
  collateralMint: "",
  lpMint: "",
  logoUrl: null,
  lpBalanceRaw: 1n,
  lpBalance: 1,
  redeemableRaw: 1n,
  totalLpSupply: 0,
  tvl: 0,
  userSharePct: 0,
  cooldownSlots: 0,
  cooldownElapsed: true,
  apr: 0,
} as const;

// Earn rows as useLpPositions builds them: poolAddress = slab, poolMode 1, kind "earn".
// Name gives no clean fallback, so the "-PERP" strip on the symbol itself is what's exercised.
const earnSol: LpPosition = { ...base, poolAddress: "EarnSlabSol", slabAddress: "EarnSlabSol", name: "Pool 7MkErbg1", symbol: "SOL-PERP", redeemable: 10, poolMode: 1, kind: "earn" };
const earnJup: LpPosition = { ...base, poolAddress: "EarnSlabJup", slabAddress: "EarnSlabJup", name: "JUP", symbol: "JUP", redeemable: 2.5, poolMode: 1, kind: "earn" };
// A trading-LP STAKE pool (poolMode 1): lives in a stake pool, managed on /stake.
const stakeTrading: LpPosition = { ...base, poolAddress: "StakePoolA", slabAddress: "SlabA", name: "PENGU", symbol: "PENGU", redeemable: 5, poolMode: 1, kind: "stake" };
// An insurance stake pool (poolMode 0).
const stakeIns: LpPosition = { ...base, poolAddress: "StakePoolB", slabAddress: "SlabB", name: "BONK", symbol: "BONK", redeemable: 7, poolMode: 0, kind: "stake" };

function sections() {
  return {
    vault: screen.getByText("Vault").closest("section") as HTMLElement,
    stake: screen.getByText("Stake").closest("section") as HTMLElement,
  };
}
const hrefs = (el: HTMLElement) => within(el).getAllByRole("link").map((a) => a.getAttribute("href"));

describe("LpPositionsPanel Vault/Stake split", () => {
  it("groups by kind: a poolMode-1 stake pool stays under Stake and links to /stake", () => {
    render(<LpPositionsPanel positions={[earnSol, stakeTrading, earnJup, stakeIns]} totalRedeemable={24.5} loading={false} error={null} />);
    const { vault, stake } = sections();
    expect(hrefs(vault)).toEqual(["/earn/EarnSlabSol", "/earn/EarnSlabJup"]);
    expect(hrefs(stake)).toEqual(["/stake", "/stake"]);
    expect(within(stake).getByText("PENGU")).toBeTruthy();
    expect(within(vault).queryByText("PENGU")).toBeNull();
  });

  it("gives each section its own redeemable total, summed by kind", () => {
    render(<LpPositionsPanel positions={[earnSol, stakeTrading, earnJup, stakeIns]} totalRedeemable={24.5} loading={false} error={null} />);
    const { vault, stake } = sections();
    // Vault = 10 + 2.5 ; Stake = 5 (poolMode-1 stake) + 7 (insurance).
    expect(within(vault).getByText("$12.50")).toBeTruthy();
    expect(within(stake).getByText("$12.00")).toBeTruthy();
    // Row counts in the section headers.
    expect(within(vault).getByText("2")).toBeTruthy();
    expect(within(stake).getByText("2")).toBeTruthy();
    // Panel-wide total unchanged.
    expect(screen.getByText("$24.50 total")).toBeTruthy();
  });

  it("shows the stake-pool details grid only for stake rows (Earn rows carry zeroed pool fields)", () => {
    render(<LpPositionsPanel positions={[earnSol, stakeTrading, stakeIns]} totalRedeemable={22} loading={false} error={null} />);
    const { vault, stake } = sections();
    expect(within(vault).queryByText("Withdraw")).toBeNull();
    expect(within(vault).queryByText("Pool TVL")).toBeNull();
    expect(within(stake).getAllByText("Withdraw")).toHaveLength(2);
    expect(within(stake).getAllByText("Pool TVL")).toHaveLength(2);
  });

  it("labels rows by what they are and strips the -PERP suffix from the symbol", () => {
    render(<LpPositionsPanel positions={[earnSol, stakeTrading, stakeIns]} totalRedeemable={22} loading={false} error={null} />);
    const { vault, stake } = sections();
    expect(within(vault).getByText("Earn vault")).toBeTruthy();
    expect(within(vault).getByText("SOL")).toBeTruthy();
    expect(screen.queryByText("SOL-PERP")).toBeNull();
    expect(within(stake).getByText("Insurance pool")).toBeTruthy();
    expect(within(stake).getByText("Stake pool")).toBeTruthy();
  });

  it("omits an empty section", () => {
    render(<LpPositionsPanel positions={[stakeTrading]} totalRedeemable={5} loading={false} error={null} />);
    expect(screen.queryByText("Vault")).toBeNull();
    expect(screen.getByText("Stake")).toBeTruthy();
  });
});
