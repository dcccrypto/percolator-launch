/**
 * #2987: the dock's liquidation price is the engine's (maintenance on the live price), and its
 * colour follows the site-wide margin-relative tiers, not a flat 20%/10% that coloured every
 * position of ~4.2x+ amber the moment it opened.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as unknown,
  priceE6: 100_000_000n as bigint | null,
}));

const OWNER = new PublicKey("11111111111111111111111111111111");
const acct = (over: Record<string, unknown>) => ({
  idx: 0,
  pubkey: OWNER,
  account: {
    kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n,
    entryPrice: 0n, adlABasis: 1_000_000_000_000_000n, reservedPnl: 0n, feeCredits: 0n,
    ...over,
  },
});

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => h.account,
  // #2560: the dock lists every owned portfolio; a single-portfolio wallet is [its account].
  useOwnerMarketPortfolios: () => (h.account ? [h.account] : []),
  useUserAccountScanPending: () => false,
}));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, prewarmClose: vi.fn() }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [],
    config: { collateralMint: OWNER, lastEffectivePriceE6: 100_000_000n, invert: 0 },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: h.priceE6, priceUsd: 100 }) }));
vi.mock("@/hooks/useMarketConfig", () => ({ useMarketConfig: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP" } }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, insuranceBalance: 0n }) }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => ({ maxFillAbs: null }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "keeper", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => null }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));
vi.mock("@/components/dev/RenderProfiler", () => ({ RenderProfiler: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/trade/OtherMarketPositions", () => ({ OtherMarketPositions: () => null }));
vi.mock("@/components/trade/TradeHistory", () => ({ TradeHistory: () => null }));
vi.mock("@/components/trade/WarmupProgress", () => ({ WarmupProgress: () => null }));
vi.mock("@/components/trade/ClosePositionModal", () => ({ ClosePositionModal: () => null }));
vi.mock("@/components/trade/PositionNftMenu", () => ({ PositionNftMenu: () => <span data-testid="nft-menu-marker" />, ClosedPositionNftNotice: () => <span data-testid="closed-nft-marker" />, NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap to close this position" } }));

import { PositionsDock } from "@/components/trade/PositionsDock";
import { saveEntryPrice } from "@/lib/entry-price";

const E6 = 1_000_000n;
beforeEach(() => {
  localStorage.clear();
  // 10x long: 1 unit at $100 on 10 USDC (mm 5% / im 10%).
  h.account = acct({ capital: 10n * E6, positionSize: 1n * E6 });
  saveEntryPrice("s", 0, 100n * E6, 10, OWNER.toBase58());
});

const liq = () => screen.getByTestId("position-liq");

describe("PositionsDock liquidation cell (#2987)", () => {
  it("shows the engine's liquidation price (94.74), not the SDK's (90.48)", () => {
    h.priceE6 = 100n * E6;
    render(<PositionsDock slabAddress="s" />);
    expect(liq().textContent).toMatch(/94\.7/);
    expect(liq().textContent).not.toMatch(/90\.4/);
  });

  it("a freshly opened 10x position is not coloured as a risk", () => {
    h.priceE6 = 100n * E6;
    render(<PositionsDock slabAddress="s" />);
    expect(liq().className).toContain("text-[var(--text-secondary)]");
  });

  it("amber at half the cushion gone, red at three quarters", () => {
    h.priceE6 = 97n * E6;
    const { unmount } = render(<PositionsDock slabAddress="s" />);
    expect(liq().className).toContain("text-[var(--warning)]");
    unmount();
    h.priceE6 = 95_800_000n;
    render(<PositionsDock slabAddress="s" />);
    expect(liq().className).toContain("text-[var(--short)]");
  });
});
