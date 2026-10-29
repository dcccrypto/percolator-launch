/**
 * App bug 2026-10-29 (product review finding 3): on a BOUND vault the Earn page's TVL, Value,
 * Share value and Earned, and the Earn rail's TVL / Your Value, were registry shares + distributed
 * fees: they never went down after a loss while the withdraw preview did. Rendered with the REAL
 * pricing (earnPanelPricing over the fixture vault, pots down to 700 against a 1,000 senior claim),
 * every figure must equal the withdraw preview's price.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { marketLimits } from "../../lib/limits/fixtures";
import { earnPanelPricing } from "@/lib/limits/earn";
import { previewWithdrawAtoms } from "@/lib/limits/earn-withdraw";
import { formatCompact } from "@/lib/formatters";

const SLAB = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const S = 1_000_000_000n;
const HELD = 100_000_000n;
const h = vi.hoisted(() => ({ backing: 700_000_000n, bound: true, limits: null as unknown, basis: null as unknown }));

const proxyState = () => ({
  bound: h.bound,
  registryExists: true,
  mintExists: true,
  lpSupply: S,
  userLpBalance: HELD,
  pendingRedemptionShares: 0n,
  hasPendingRedemption: false,
  // the old proxy: shares + 5 USDC of distributed fees
  vaultTotalAtoms: S + 5_000_000n,
  vaultSharePriceE6: 1_005_000n,
  userVaultValueAtoms: (HELD * (S + 5_000_000n)) / S,
  userSharePct: 10,
  backingNavAtoms: h.backing,
  splitPot: null,
  redemptionCooldownSlots: 0n,
  cooldownElapsed: true,
  cooldownRemainingSlots: 0n,
  userCollateralBalance: 0n,
  lpVaultDomain: 0,
  lpDecimals: 6,
});

vi.mock("next/navigation", () => ({ useParams: () => ({ slab: SLAB }) }));
// next/dynamic -> React.lazy over the real loader (the page loads LpPositionDashboard this way).
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
      const Lazy = React.lazy(async () => ({ default: await loader() }));
      return (p: Record<string, unknown>) => React.createElement(React.Suspense, { fallback: null }, React.createElement(Lazy, p));
    },
  };
});
vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: React.ReactNode }) => children,
  useSlabState: () => ({ config: null, raw: null, programId: null }),
}));
vi.mock("@/hooks/useInsuranceLP", () => ({
  useInsuranceLP: () => ({
    state: proxyState(),
    loading: false,
    readError: false,
    deposit: vi.fn(),
    withdraw: vi.fn(),
    resizeRedemption: vi.fn(),
    refreshState: vi.fn(),
    lastDrawSummary: null,
  }),
}));
vi.mock("@/hooks/useLpCostBasis", () => ({ useLpCostBasis: () => h.basis }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => h.limits }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/hooks/useVaultLpValuation", () => ({ useVaultLpValuation: () => ({ value: null, sim: null, updating: false, asOf: null }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, totalOI: null, vault: null }) }));
vi.mock("@/hooks/useEarnStats", () => ({
  useEarnStats: () => ({ stats: { markets: [] }, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useLpShareToken", () => ({ useLpShareToken: () => ({ decimals: 6, metadataPresent: true }) }));
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }) }),
}));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/ui/AnimatedNumber", () => ({
  AnimatedNumber: ({ value, prefix = "", decimals = 2 }: { value: number; prefix?: string; decimals?: number }) => (
    <span data-testid="animated">{`${prefix}${value.toFixed(decimals)}`}</span>
  ),
}));
vi.mock("@/components/limits/ResolvedExitPanel", () => ({ ResolvedExitPanel: () => null }));
vi.mock("@/components/earn/DepositWithdrawPanel", () => ({ DepositWithdrawPanel: () => null }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));

import VaultDetailPage from "@/app/earn/[slab]/page";
import { VaultDepositRail } from "@/components/earn/VaultDepositRail";

const pricing = () => earnPanelPricing(h.limits as never, h.backing)!;
const usd = (atoms: bigint) => Number(atoms) / 1e6;

beforeEach(() => {
  h.backing = 700_000_000n;
  h.bound = true;
  h.limits = marketLimits();
  h.basis = { basisKnown: true, lpShares: HELD, costBasisAtoms: HELD, realizedPnlAtoms: 0n };
});

describe("Earn market page, bound vault after a loss", () => {
  it("TVL, Value and Share value are the withdraw price, below the old shares + fees", async () => {
    const p = pricing();
    const value = previewWithdrawAtoms(HELD, S, p.withdrawSeniorValue)!;
    expect(value).toBeLessThan(HELD);
    render(<VaultDetailPage />);
    await waitFor(() => expect(screen.getByTestId("earn-page-tvl").textContent).toBe(`$${formatCompact(usd(p.withdrawSeniorValue!))}`));
    // Value (LpPositionDashboard headline)
    const dash = (await screen.findByText("Your Earn position")).closest(".hud-corners") as HTMLElement;
    expect(screen.getAllByTestId("animated").map((n) => n.textContent)).toContain(usd(value).toFixed(4));
    // Share value
    const sharePrice = Number((p.withdrawSeniorValue! * 1_000_000n) / S) / 1e6;
    const shareCell = within(dash).getByText("Share value").parentElement!;
    expect(shareCell.textContent).toContain(`${sharePrice.toFixed(4)} USDC`);
    expect(shareCell.textContent).not.toContain("1.0050");
    // the tranche card's Share value agrees
    expect(screen.getByTestId("limits-share-price").getAttribute("data-price-e6")).toBe(((p.withdrawSeniorValue! * 1_000_000n) / S).toString());
  });

  it("Earned is negative: Value minus cost basis", async () => {
    const p = pricing();
    const earned = previewWithdrawAtoms(HELD, S, p.withdrawSeniorValue)! - HELD;
    expect(earned).toBeLessThan(0n);
    render(<VaultDetailPage />);
    const row = await screen.findByTestId("lp-earned");
    expect(row.textContent).toContain(`−${(Number(-earned) / 1e6).toFixed(2)}`.replace("−", ""));
    expect(row.querySelector(".text-\\[var\\(--short\\)\\]")).not.toBeNull();
  });

  it("no program price yet: '—', never shares + fees", async () => {
    h.limits = { ...marketLimits(), registryShares: null };
    render(<VaultDetailPage />);
    await waitFor(() => expect(screen.getByTestId("earn-page-tvl").textContent).toBe("—"));
    const dash = (await screen.findByText("Your Earn position")).closest(".hud-corners") as HTMLElement;
    expect(within(dash).getByTestId("lp-value-unpriced")).toBeTruthy();
    expect(within(dash).getByText("Share value").parentElement!.textContent).toContain("—");
    expect(screen.queryByText(/1\.0050/)).toBeNull();
  });

  it("settled market: figures follow the resolved payout", async () => {
    const base = marketLimits();
    h.limits = marketLimits({ engine: { ...base.engine!, mode: 1 } });
    const p = pricing();
    render(<VaultDetailPage />);
    await waitFor(() => expect(screen.getByTestId("earn-page-tvl").textContent).toBe(`$${formatCompact(usd(p.withdrawSeniorValue!))}`));
  });
});

describe("Earn rail, bound vault after a loss", () => {
  it("TVL and Your Value are the withdraw price; the table is told the same value", async () => {
    const p = pricing();
    const value = previewWithdrawAtoms(HELD, S, p.withdrawSeniorValue)!;
    const onPositionResolved = vi.fn();
    render(<VaultDepositRail slab={SLAB} vault={null} onPositionResolved={onPositionResolved} />);
    await waitFor(() => expect(screen.getByTestId("earn-rail-figure-tvl").textContent).toBe(`$${formatCompact(usd(p.withdrawSeniorValue!))}`));
    expect(screen.getByTestId("earn-rail-figure-your-value").textContent).toBe(`$${formatCompact(usd(value))}`);
    await waitFor(() => expect(onPositionResolved).toHaveBeenLastCalledWith(SLAB, usd(value)));
  });

  it("no program price yet: TVL and Your Value read '—' and nothing is reported up", async () => {
    h.limits = { ...marketLimits(), registryShares: null };
    const onPositionResolved = vi.fn();
    render(<VaultDepositRail slab={SLAB} vault={null} onPositionResolved={onPositionResolved} />);
    await waitFor(() => expect(screen.getByTestId("earn-rail-figure-tvl").textContent).toBe("—"));
    expect(screen.getByTestId("earn-rail-figure-your-value").textContent).toBe("—");
    expect(onPositionResolved).not.toHaveBeenCalled();
  });

  it("CONTROL: a non-bound legacy vault keeps its own figures", async () => {
    h.bound = false;
    h.limits = { ...marketLimits(), vaultLp: null };
    render(<VaultDepositRail slab={SLAB} vault={null} />);
    await waitFor(() => expect(screen.getByTestId("earn-rail-figure-tvl").textContent).toBe(`$${formatCompact(usd(S + 5_000_000n))}`));
  });
});
