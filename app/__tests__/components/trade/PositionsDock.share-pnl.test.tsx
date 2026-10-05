/**
 * credit/2907: what the trade dock hands the Share-PnL card. The REAL dock
 * builds the data; PnlShareButton is replaced by a probe that records it, and
 * the recorded data is then rendered through the REAL PnlShareModal.
 *
 *  b. logo_url + mainnet_ca come from the market row — never the devnet mint.
 *  e. Only for a CACHED entry; a derived (on-chain-pnl) entry gets no card.
 *  f. The pool payout capacity rides along, so the card caps exactly where the
 *     dock shows its caveat.
 */
import "@testing-library/jest-dom";
import { render, screen, cleanup } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as unknown,
  priceE6: 100_000_000n as bigint | null,
  market: null as Record<string, unknown> | null,
  insurance: 0n as bigint | null,
  shared: [] as unknown[],
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
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: h.priceE6, priceUsd: h.priceE6 === null ? null : Number(h.priceE6) / 1e6 }) }));
vi.mock("@/hooks/useMarketConfig", () => ({ useMarketConfig: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: h.market }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, insuranceBalance: h.insurance }) }));
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

vi.mock("@/components/share/PnlShareButton", () => ({
  PnlShareButton: ({ data }: { data: unknown }) => {
    h.shared.push(data);
    return data ? <button>Share PnL</button> : null;
  },
}));
vi.mock("@/lib/priceStore/priceStore", () => ({
  subscribeSlab: () => () => {},
  getSnapshot: () => ({ priceUsd: null, priceE6: null }),
}));

import { PositionsDock } from "@/components/trade/PositionsDock";
import { PnlShareModal } from "@/components/share/PnlShareModal";
import { saveEntryPrice } from "@/lib/entry-price";
import type { PnlCardData } from "@/lib/pnl-card";

const DEVNET_MINT = "DevnetMint11111111111111111111111111111111";
const lastShared = () => h.shared[h.shared.length - 1] as PnlCardData | null;

beforeEach(() => {
  localStorage.clear();
  h.priceE6 = 100_000_000n;
  h.account = acct({});
  h.insurance = 0n;
  h.shared = [];
  h.market = { symbol: "SOL-PERP", name: "Solana", logo_url: null, mainnet_ca: "So11111111111111111111111111111111111111112", mint_address: DEVNET_MINT };
});
afterEach(() => cleanup());

describe("PositionsDock -> Share-PnL card data", () => {
  it("cached entry: offers the card, with logo_url + mainnet_ca from the market row and no devnet mint", () => {
    // Entry $99.875, mark $100, 40 units long => +$5.
    saveEntryPrice("s", 0, 99_875_000n, 4, OWNER.toBase58());
    h.market = { ...h.market, logo_url: "https://cdn.example/sol.png" };
    render(<PositionsDock slabAddress="s" />);
    const d = lastShared();
    expect(d).not.toBeNull();
    expect(d!.logoUrl).toBe("https://cdn.example/sol.png");
    expect(d!.mainnetCa).toBe("So11111111111111111111111111111111111111112");
    expect(JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(DEVNET_MINT);
    expect(screen.getByText("Share PnL")).toBeInTheDocument();
  });

  it("derived entry (back-solved from on-chain pnl, nothing cached): no card", () => {
    h.account = acct({ pnl: 5_000_000n });
    render(<PositionsDock slabAddress="s" />);
    expect(h.shared.length).toBeGreaterThan(0);
    expect(lastShared()).toBeNull();
    expect(screen.queryByText("Share PnL")).toBeNull();
  });

  it("pool-capped: the dock flags it, and the card built from the same data shows the payable $2.00, not +$5.00", () => {
    saveEntryPrice("s", 0, 99_875_000n, 4, OWNER.toBase58());
    h.insurance = 2_000_000n; // pool can pay $2 of the +$5
    const { container } = render(<PositionsDock slabAddress="s" />);
    expect(container.textContent ?? "").toContain("$5.00"); // the dock's paper figure...
    expect(document.body.textContent ?? "").toMatch(/Vault \+ insurance can currently pay up to 2/); // ...and its cap caveat
    const d = lastShared()!;
    expect(d.payableCapacityAtoms).toBe(2_000_000n);
    cleanup();
    render(<PnlShareModal data={d} onClose={() => {}} />);
    expect(screen.getByTestId("pnl-card-amount")).toHaveTextContent("+$2.00");
    expect(screen.getByTestId("pnl-card-capped")).toHaveTextContent("paper +$5.00");
  });
});
