/**
 * N18: the /markets Health sort ranked from the stats grade only, while the row badge applies the
 * live read (lib/market-health-overlay.ts liveHealthLevel). An LP-depleted ("Needs liquidity") or
 * ADL close-only market grades healthy from stats, so it sorted with the markets you can open on.
 * The live read also covered only the first 50 visible rows, chosen after sorting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const A = "AAAA1111111111111111111111111111111111111111"; // healthy
const B = "BBBB1111111111111111111111111111111111111111"; // LP depleted
const C = "CCCC1111111111111111111111111111111111111111"; // ADL close-only
const D = "DDDD1111111111111111111111111111111111111111"; // healthy

const h = vi.hoisted(() => ({
  health: {} as Record<string, unknown>,
  useMarketHealth: vi.fn(),
  /** Listed slabs, in statsMap order. */
  slabs: [] as string[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("sort=health"),
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: {} }),
  useWalletCompat: () => ({ publicKey: null }),
}));
vi.mock("@/hooks/useMarketDiscovery", () => ({ useMarketDiscovery: () => ({ markets: [], loading: false, error: null }) }));
const statsRow = (slab: string) => ({
  slab_address: slab,
  last_price: 1,
  mark_price: 1,
  index_price: 1,
  total_open_interest_usd: 100,
  dex_pool_address: "pool",
  max_leverage: 10,
});
vi.mock("@/hooks/useAllMarketStats", () => ({
  // Map order puts the bad markets first, so a stable sort that ignores the live read keeps them on top.
  useAllMarketStats: () => ({ statsMap: new Map(h.slabs.map((s) => [s, statsRow(s)])), loading: false, error: null }),
}));
vi.mock("@/hooks/useMarketHealth", () => ({
  useMarketHealth: (slabs: readonly string[]) => h.useMarketHealth(slabs),
}));
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/lib/slabCache", () => ({ prefetchSlab: vi.fn(), prefetchSlabsBatch: vi.fn() }));
vi.mock("@/components/market/LiveRowPrice", () => ({ LiveRowPrice: () => null }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/market/WatchButton", () => ({ WatchButton: () => null }));
vi.mock("@/components/market/MarketHealthBadges", () => ({ MarketHealthBadges: () => null }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import MarketsPage from "@/app/markets/page";

const row = (badge: string) => ({
  badges: [{ id: badge, label: badge, tone: "danger", detail: "" }],
  lockReasons: [],
  lpDepleted: badge === "lp-depleted",
  lpCapital: "0",
  payoutHaircutBps: 0,
  openProfitAtoms: "0",
  realizableProfitAtoms: "0",
});

/** Slabs in the order the desktop table links them (first link per market). */
function rowOrder(): string[] {
  const seen: string[] = [];
  for (const a of screen.getAllByRole("link")) {
    const m = (a.getAttribute("href") ?? "").match(/\/trade\/([A-Za-z0-9]+)/);
    if (m && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

beforeEach(() => {
  cleanup();
  h.slabs = [B, C, A, D];
  h.health = { [B]: row("lp-depleted"), [C]: row("adl-reduce-only") };
  h.useMarketHealth.mockReset();
  h.useMarketHealth.mockImplementation(() => ({ health: h.health, loading: false, refresh: vi.fn() }));
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
});

describe("N18: the Health sort ranks by the live grade the badge shows", () => {
  it("needs-liquidity and close-only markets sort below the healthy ones, needs-liquidity first", () => {
    render(<MarketsPage />);
    expect(rowOrder()).toEqual([A, D, B, C]);
  });

  it("CONTROL: with no live read, the stats grade (all healthy) keeps the input order", () => {
    h.health = {};
    render(<MarketsPage />);
    expect(rowOrder()).toEqual([B, C, A, D]);
  });

  it("live health is read for every listed market, not only the first 50 rows on screen", () => {
    h.slabs = Array.from({ length: 60 }, (_, i) => `M${String(i).padStart(2, "0")}${"1".repeat(41)}`);
    render(<MarketsPage />);
    const asked = h.useMarketHealth.mock.calls.map((c) => [...(c[0] as string[])].sort());
    expect(asked).toContainEqual([...h.slabs].sort());
  });
});
