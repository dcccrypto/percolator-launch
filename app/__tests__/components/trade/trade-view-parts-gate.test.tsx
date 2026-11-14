/**
 * /trade loads its post-skeleton UI (ticket, dock, market bar, ...) from ./trade-view-parts on mount.
 * The skeleton stays until both the slab and the parts are there. (The chunk-failure path was checked in
 * a browser against a production build with the chunk blocked; vitest cannot reject this dynamic import.)
 */
import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const { SLAB, slab } = vi.hoisted(() => ({ SLAB: "G2wipz3k28TyVqdKnzpTcEGWkB4bHJXwNrCbi4DVgPez", slab: { state: {} as Record<string, unknown> } }));

vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: React.ReactNode }) => children,
  useSlabState: () => slab.state,
}));
vi.mock("@/components/providers/UsdToggleProvider", () => ({ UsdToggleProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/useLivePrice", async (orig) => ({ ...(await orig<object>()), useLivePriceHasData: () => true, livePriceJsonFetcher: () => new Promise(() => {}) }));
vi.mock("@/hooks/useWalletCompat", async (orig) => ({ ...(await orig<object>()), useWalletCompat: () => ({ publicKey: null, connected: false }) }));
vi.mock("@/hooks/useIsLargeScreen", () => ({ useIsLargeScreen: () => true }));
vi.mock("@/components/trade/ChartSwitch", () => ({ ChartSwitch: () => null }));
vi.mock("@/components/trade/AnalyticsDock", () => ({ AnalyticsDock: () => null }));
vi.mock("@/components/trade/ResolvedClaimPanel", () => ({ ResolvedClaimPanel: () => null }));
// The test env runs React 18, which has no use(); the page only uses it to read `params`.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), use: () => ({ slab: SLAB }) }));
// next/dynamic (chart, preload helper) renders nothing here; this file tests the parts gate only.
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

// The parts module (app/trade/[slab]/trade-view-parts.ts) re-exports these.
const stub = (id: string) => () => <div data-testid={id} />;
vi.mock("@/components/trade/OrderTicket", () => ({ OrderTicket: stub("parts-order-ticket") }));
vi.mock("@/components/trade/PositionsDock", () => ({ PositionsDock: stub("parts-positions-dock") }));
vi.mock("@/components/trade/MarketInfoBar", () => ({ MarketInfoBar: stub("parts-market-bar") }));
vi.mock("@/components/limits/MarketLimitsStrip", () => ({ MarketLimitsStrip: () => null }));
vi.mock("@/components/market/MarketHealthBadges", () => ({ MarketHeaderStatus: () => null, TradeMarketHealthBanner: () => null }));
vi.mock("@/components/trade/MobileTradeBand", () => ({ MobileTradeBand: () => null }));
vi.mock("@/components/trade/MultiAssetNotice", () => ({ MultiAssetNotice: () => null }));

const loaded = () => ({ engine: null, config: { collateralMint: new PublicKey("11111111111111111111111111111111") }, header: null, raw: null, loading: false, error: null, layoutUnsupported: false });

async function renderPage() {
  const { default: TradePage } = await import("@/app/trade/[slab]/page");
  const params = Promise.resolve({ slab: SLAB });
  await act(async () => {
    render(<Suspense fallback={null}><TradePage params={params} /></Suspense>);
  });
}

beforeEach(() => {
  vi.resetModules();
  slab.state = loaded();
});

describe("/trade view parts gate", () => {
  it("renders the parts once they load (skeleton until then)", async () => {
    await renderPage();
    expect(await screen.findByTestId("parts-order-ticket", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByTestId("parts-positions-dock")).toBeTruthy();
    expect(screen.getByTestId("parts-market-bar")).toBeTruthy();
  });

  it("keeps the skeleton while the slab is still loading, even with the parts loaded", async () => {
    slab.state = { ...loaded(), loading: true, config: null };
    await renderPage();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("parts-order-ticket")).toBeNull();
  });
});
