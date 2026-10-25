/**
 * /markets lifecycle state: unread lifecycle data shows the market (never hides it), retired is hidden by default and listed under its
 * filter, the badge renders, the filter exists only on v2.2 builds, and the list waits for the first read instead of flashing retired rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const A = "AAAA1111111111111111111111111111111111111111";
const B = "BBBB1111111111111111111111111111111111111111";
const C = "CCCC1111111111111111111111111111111111111111";

const h = vi.hoisted(() => ({
  slabs: [] as string[],
  search: "",
  lifecycles: new Map<string, { state: string }>(),
  ready: true,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: {} }),
  useWalletCompat: () => ({ publicKey: null }),
}));
vi.mock("@/hooks/useMarketDiscovery", () => ({ useMarketDiscovery: () => ({ markets: [], loading: false, error: null }) }));
const statsRow = (slab: string) => ({ slab_address: slab, last_price: 1, mark_price: 1, index_price: 1, total_open_interest_usd: 100, dex_pool_address: "pool", max_leverage: 10 });
vi.mock("@/hooks/useAllMarketStats", () => ({
  useAllMarketStats: () => ({ statsMap: new Map(h.slabs.map((s) => [s, statsRow(s)])), loading: false, error: null }),
}));
vi.mock("@/hooks/useMarketLifecycles", () => ({ useMarketLifecycles: () => ({ lifecycles: h.lifecycles, ready: h.ready }) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useMarketHealth: () => ({ health: {}, loading: false, refresh: vi.fn() }) }));
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/lib/slabCache", () => ({ prefetchSlab: vi.fn(), prefetchSlabsBatch: vi.fn() }));
vi.mock("@/components/market/LiveRowPrice", () => ({ LiveRowPrice: () => null }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/market/WatchButton", () => ({ WatchButton: () => null }));
vi.mock("@/components/market/MarketHealthBadges", () => ({ MarketHealthBadges: () => null }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import MarketsPage from "@/app/markets/page";

function listed(): string[] {
  const seen: string[] = [];
  for (const a of screen.queryAllByRole("link")) {
    const m = (a.getAttribute("href") ?? "").match(/\/trade\/([A-Za-z0-9]+)/);
    if (m && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

beforeEach(() => {
  cleanup();
  __setDevnetV22ForTest(true);
  h.slabs = [A, B, C];
  h.search = "";
  h.lifecycles = new Map();
  h.ready = true;
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => __setDevnetV22ForTest(null));

describe("/markets lifecycle", () => {
  it("unread lifecycle data shows every market (nothing hidden on no information)", () => {
    render(<MarketsPage />);
    expect(listed().sort()).toEqual([A, B, C]);
    expect(screen.queryByTestId(/^lifecycle-badge-/)).toBeNull();
  });
  it("retired is hidden by default; the other states stay, and the badge renders", () => {
    h.lifecycles = new Map([[A, { state: "retired" }], [B, { state: "stale" }], [C, { state: "settled" }]]);
    render(<MarketsPage />);
    expect(listed().sort()).toEqual([B, C]);
    expect(screen.getAllByTestId("lifecycle-badge-stale").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("lifecycle-badge-settled").length).toBeGreaterThan(0);
  });
  it("?state=retired lists only the retired market", () => {
    h.lifecycles = new Map([[A, { state: "retired" }], [B, { state: "live" }], [C, { state: "settled" }]]);
    h.search = "state=retired";
    render(<MarketsPage />);
    expect(listed()).toEqual([A]);
  });
  it("Recovery with nothing open is settling, so it is not hideable by the default list", () => {
    h.lifecycles = new Map([[A, { state: "settling" }]]);
    render(<MarketsPage />);
    expect(listed()).toContain(A);
  });
  it("the state filter renders with a pill per state on v2.2 and not at all with the flag off", () => {
    render(<MarketsPage />);
    const f = screen.getByTestId("lifecycle-filter");
    expect(f.textContent).toMatch(/ALL.*Live.*Stale.*Settling.*Settled.*Retired/);
    cleanup();
    __setDevnetV22ForTest(false);
    render(<MarketsPage />);
    expect(screen.queryByTestId("lifecycle-filter")).toBeNull();
  });
  it("until the first lifecycle read lands nothing is listed (no retired flash, no empty ?state= result)", () => {
    h.ready = false;
    h.search = "state=stale";
    render(<MarketsPage />);
    expect(listed()).toEqual([]);
    expect(screen.queryByText(/nothing here/i)).toBeNull();
  });
});
