/**
 * S11 + S12: the Earn Insurance figure showed "$0" before it had been read. The hub's
 * Insurance Fund card took no loading state (the header's cell for the same figure does),
 * and the vault page fell back to `insuranceFund ?? 0` while the cells beside it show "—".
 */
import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({ hasData: false, loading: false }));
vi.mock("@/hooks/useEarnStats", () => ({
  useEarnStats: () => ({
    stats: { markets: [], tvl: 0, totalOI: 0, maxOI: 0, totalInsurance: S.hasData ? 1500 : 0 },
    loading: S.loading,
    error: S.hasData ? null : "Couldn't load vault data. Retrying every 15 seconds.",
    hasData: S.hasData,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/earn/EarnHeader", () => ({ EarnHeader: () => null }));
vi.mock("@/components/earn/VaultDepositRail", () => ({ VaultDepositRail: () => null }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: vi.fn(async () => new Map()) }));

import { EarnVaultView } from "@/components/earn/EarnVaultView";

const figure = () => screen.getByTestId("earn-insurance-figure").textContent;

describe("Earn hub Insurance Fund card (S11)", () => {
  it("cold load: '—', not $0", async () => {
    S.hasData = false;
    S.loading = true;
    render(<EarnVaultView />);
    await waitFor(() => expect(figure()).toBe("—"));
  });

  it("failed first load: still '—'", async () => {
    S.hasData = false;
    S.loading = false;
    render(<EarnVaultView />);
    await waitFor(() => expect(figure()).toBe("—"));
  });

  it("CONTROL: once read, the figure shows", async () => {
    S.hasData = true;
    S.loading = false;
    render(<EarnVaultView />);
    await waitFor(() => expect(figure()).toBe("$1.50K"));
  });
});

describe("Earn vault page Insurance cell (S12)", () => {
  const page = readFileSync(resolve(process.cwd(), "app/earn/[slab]/page.tsx"), "utf8");
  it("shows '—' until marketInfo resolves, like Open Interest and Max Leverage", () => {
    expect(page).not.toMatch(/insuranceFund \?\? 0/);
    expect(page).toContain('{marketInfo && marketInfo.insuranceFund != null ? `$${formatCompact(marketInfo.insuranceFund / collDivisor)}` : "—"}');
  });
});

// Follow-up to #3457: a market with no stats row (registered, vault found) was given insuranceFund 0,
// so its cell read "$0" and it counted as an empty fund in the total. Unknown is null now.
describe("insurance unknown when no stats row carries it", () => {
  it("a market without a stats row has no insurance figure; a row's 0 stays 0", async () => {
    const { buildMarketVaultInfo } = await vi.importActual<typeof import("@/hooks/useEarnStats")>("@/hooks/useEarnStats");
    const slab = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
    expect(buildMarketVaultInfo(slab, "T", "t", null, {}, new Map()).insuranceFund).toBeNull();
    expect(buildMarketVaultInfo(slab, "T", "t", null, {}, new Map([[slab, { insurance_fund: 0 }]])).insuranceFund).toBe(0);
    expect(buildMarketVaultInfo(slab, "T", "t", null, {}, new Map([[slab, { insurance_fund: 2_500_000 }]])).insuranceFund).toBe(2_500_000);
    // An untrusted value (negative, a u64::MAX-class sentinel, not a number) is unknown too, not $0.
    for (const bad of [-1, 2e19, "abc"]) {
      expect(buildMarketVaultInfo(slab, "T", "t", null, {}, new Map([[slab, { insurance_fund: bad }]])).insuranceFund).toBeNull();
    }
  });

  it("the total sums the known figures, and is null when none is known", async () => {
    const { computeAggregates } = await vi.importActual<typeof import("@/hooks/useEarnStats")>("@/hooks/useEarnStats");
    const m = (insuranceFund: number | null) => ({ insuranceFund, decimals: 6, vaultBalance: 0, totalOI: 0, maxOI: 0, volume24h: 0, tradingFeeBps: 0, symbol: "T" }) as never;
    expect(computeAggregates([m(null), m(null)]).totalInsurance).toBeNull();
    expect(computeAggregates([m(null), m(3_000_000), m(0)]).totalInsurance).toBe(3);
  });

  it("the Earn header shows a dash for an unknown total", async () => {
    const { EarnHeader } = await vi.importActual<typeof import("@/components/earn/EarnHeader")>("@/components/earn/EarnHeader");
    render(<EarnHeader stats={{ markets: [], tvl: 1, dailyFeeRevenue: 1, totalInsurance: null, totalOI: 0, maxOI: 0, unvaluedSymbols: [] } as never} loading={false} />);
    const cell = screen.getByText("Insurance Fund").closest("div")!.parentElement!;
    expect(cell.textContent).toContain("—");
    expect(cell.textContent).not.toContain("$0");
  });
});
