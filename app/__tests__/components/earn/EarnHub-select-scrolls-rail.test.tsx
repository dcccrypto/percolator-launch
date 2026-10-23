/**
 * Below lg the deposit rail renders under the vault table, so tapping a vault on a phone only
 * re-bound the rail off-screen: nothing visible changed. A row tap now scrolls the rail into view
 * there; on desktop (rail sticky beside the table) and on the initial auto-select it doesn't.
 */
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const FIRST = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const OTHER = "Fz5JfUcbEdt5DNSNwZpBn2dZ7NpN8MnvJMiYjnqMacMh";
const market = (slabAddress: string, symbol: string) => ({
  slabAddress, symbol, name: symbol, mainnetCa: null, vaultBalance: 9_000_000_000, totalOI: 0, maxOI: 0,
  insuranceFund: 0, tradingFeeBps: 10, maxLeverage: 10, oiUtilPct: 0, decimals: 6, hasVault: true,
});
const STATS = {
  stats: { markets: [market(FIRST, "PERCOLATOR"), market(OTHER, "TRENDS")], tvl: 0, totalOI: 0, maxOI: 0, totalInsurance: 0 },
  loading: false, error: null, hasData: true, refresh: vi.fn(),
};
vi.mock("@/hooks/useEarnStats", () => ({ useEarnStats: () => STATS }));
vi.mock("@/components/earn/EarnHeader", () => ({ EarnHeader: () => null }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: null }),
  useConnectionCompat: () => ({ connection: {} }),
}));
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: vi.fn(async () => new Map()) }));
vi.mock("@/components/earn/VaultDepositRail", () => ({
  VaultDepositRail: ({ slab }: { slab: string | null }) => <div data-testid="rail">{slab}</div>,
}));

import { EarnVaultView } from "@/components/earn/EarnVaultView";

function atWidth(desktop: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: desktop && q.includes("min-width: 64rem"), media: q, addEventListener() {}, removeEventListener() {} }));
}

describe("Earn: selecting a vault on a phone brings the deposit rail into view", () => {
  let scrolled: Element[];
  let opts: unknown[];
  beforeEach(() => {
    scrolled = [];
    opts = [];
    Element.prototype.scrollIntoView = function (this: Element, o?: unknown) { scrolled.push(this); opts.push(o); };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("scrolls the rail into view when a row is tapped below lg", () => {
    atWidth(false);
    render(<EarnVaultView />);
    fireEvent.click(screen.getAllByText("TRENDS")[0]);
    expect(screen.getByTestId("rail")).toHaveTextContent(OTHER);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].contains(screen.getByTestId("rail"))).toBe(true);
    // Its top lands below the sticky header, and the html scroll-behavior (reduced motion) applies.
    expect(opts[0]).toEqual({ block: "start" });
    expect(scrolled[0]).toHaveClass("scroll-mt-24");
  });

  it("doesn't scroll on desktop, where the rail is beside the table", () => {
    atWidth(true);
    render(<EarnVaultView />);
    fireEvent.click(screen.getAllByText("TRENDS")[0]);
    expect(screen.getByTestId("rail")).toHaveTextContent(OTHER);
    expect(scrolled).toHaveLength(0);
  });

  it("doesn't scroll on the initial auto-select of the first vault", () => {
    atWidth(false);
    render(<EarnVaultView />);
    expect(screen.getByTestId("rail")).toHaveTextContent(FIRST);
    expect(scrolled).toHaveLength(0);
  });
});
