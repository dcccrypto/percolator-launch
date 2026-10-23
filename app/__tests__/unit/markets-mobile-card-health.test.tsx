/**
 * N19: the phone /markets card showed logo, symbol, price and OI / Vol / leverage only. The Health
 * badge sits in the desktop columns (`hidden md:contents`), so on a phone a Close-only or Needs
 * liquidity market looked like any other until an open was refused, while the phone sort offered
 * Health. The card now names the states that refuse new positions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

const OK = "AAAA1111111111111111111111111111111111111111";
const LP_DEPLETED = "BBBB1111111111111111111111111111111111111111";
const ADL = "CCCC1111111111111111111111111111111111111111";
const NO_PRICE = "DDDD1111111111111111111111111111111111111111"; // pool set, no price yet

const h = vi.hoisted(() => ({ health: {} as Record<string, unknown> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
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
  useAllMarketStats: () => ({
    statsMap: new Map([
      ...[OK, LP_DEPLETED, ADL].map((s) => [s, statsRow(s)] as const),
      [NO_PRICE, { ...statsRow(NO_PRICE), last_price: null, mark_price: null, index_price: null }] as const,
    ]),
    loading: false,
    error: null,
  }),
}));
vi.mock("@/hooks/useMarketHealth", () => ({ useMarketHealth: () => ({ health: h.health, loading: false, refresh: vi.fn() }) }));
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

/** The phone card of the market linking to /trade/<slab>. */
function card(slab: string): HTMLElement {
  const link = screen.getAllByRole("link").find((a) => a.getAttribute("href")?.includes(slab));
  if (!link) throw new Error(`no row for ${slab}`);
  return within(link).getByTestId("market-card");
}

beforeEach(() => {
  cleanup();
  h.health = { [LP_DEPLETED]: row("lp-depleted"), [ADL]: row("adl-reduce-only") };
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
});

describe("N19: the phone market card names a state that refuses new positions", () => {
  it("Needs liquidity, Close-only and Awaiting price show on the card", () => {
    render(<MarketsPage />);
    expect(within(card(LP_DEPLETED)).getByTestId("market-card-health").textContent).toBe("Needs liquidity");
    expect(within(card(ADL)).getByTestId("market-card-health").textContent).toBe("Close-only");
    expect(within(card(NO_PRICE)).getByTestId("market-card-health").textContent).toBe("Awaiting price");
  });

  it("CONTROL: a healthy market's card has no badge", () => {
    render(<MarketsPage />);
    expect(within(card(OK)).queryByTestId("market-card-health")).toBeNull();
  });
});
