/**
 * credit/2907: what /portfolio hands the Share-PnL card. The REAL
 * PortfolioPositionsView builds the data; PnlShareButton is replaced by a probe.
 *
 *  b. logo_url + mainnet_ca come from markets_with_stats (statsMap) — never the devnet mint.
 *  e. Only for a CACHED entry (the dock's rule). A "derived" entry is an estimate
 *     back-solved from on-chain pnl, and an "unknown" one is the mark: no card.
 *  f. The row asks for live slab capacity so the card can apply the pool cap.
 */
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";

const h = vi.hoisted(() => ({ shared: new Map<string, { data: unknown; liveSlabCapacity?: boolean }>() }));

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }));
vi.mock("next/dynamic", () => ({ default: () => () => <button>ConnectButton</button> }));
vi.mock("@/hooks/useWalletCompat");
vi.mock("@/hooks/usePortfolio", async (io) => ({ ...(await io<typeof import("@/hooks/usePortfolio")>()), usePortfolio: vi.fn() }));
vi.mock("@/hooks/useMultiTokenMeta");
vi.mock("@/hooks/useLpPositions", () => ({ useLpPositions: () => ({ positions: [], totalRedeemable: 0, loading: false, isRefreshing: false, error: null, refresh: vi.fn() }) }));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({ LpPositionsPanel: () => <div /> }));
vi.mock("@/hooks/useTraderStats", () => ({ useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: vi.fn() }) }));
vi.mock("@/components/trade/TradeStatsPanel", () => ({ TradeStatsPanel: () => <div /> }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/ui/GlowButton", () => ({ GlowButton: ({ children }: any) => <button>{children}</button> }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/hooks/useAllMarketStats", () => ({
  useAllMarketStats: () => ({
    statsMap: new Map([
      ["SlabCache11111", { symbol: "SOL", name: "Solana", logo_url: null, mainnet_ca: "MainnetCaSol111", mint_address: "DevnetMint111" }],
      ["SlabLogo111111", { symbol: "SOL", name: "Solana", logo_url: "https://cdn.example/sol.png", mainnet_ca: "MainnetCaSol111", mint_address: "DevnetMint111" }],
    ]),
  }),
}));
vi.mock("@/components/share/PnlShareButton", () => ({
  PnlShareButton: ({ data, liveSlabCapacity }: { data: { slab?: string } | null; liveSlabCapacity?: boolean }) => {
    if (data?.slab) h.shared.set(data.slab, { data, liveSlabCapacity });
    return data ? <button>Share PnL</button> : null;
  },
}));

import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import type { PnlCardData } from "@/lib/pnl-card";

const pk = new PublicKey("11111111111111111111111111111111");
const row = (slab: string, entryPriceSource: "cache" | "derived" | "unknown") => ({
  slabAddress: slab, symbol: "SOL", idx: 0, collateralMint: pk,
  account: { kind: AccountKind.User, owner: pk, capital: 1_000_000n, positionSize: 5_000_000n, pnl: 0n, entryPrice: 0n },
  market: { slabAddress: pk, config: { collateralMint: pk }, engine: {} },
  effectiveEntryPrice: 95_000_000n, entryPriceSource, effectiveSize: 5_000_000n,
  unrealizedPnl: 0n, oraclePriceE6: 100_000_000n, pnlPercent: 0, leverage: 5,
  liquidationPriceE6: 80_000_000n, liquidationDistancePct: 100, nftWrapped: false,
});

beforeEach(() => {
  h.shared.clear();
  vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: pk } as any);
  vi.mocked(useMultiTokenMeta).mockReturnValue(new Map([[pk.toBase58(), { symbol: "SOL", decimals: 6 }]]) as any);
});

const renderRows = (rows: ReturnType<typeof row>[]) => {
  vi.mocked(usePortfolio).mockReturnValue({ positions: rows, totalPnl: 0n, totalDeposited: 2_000_000n, loading: false, refresh: vi.fn() } as any);
  return render(<PortfolioPositionsView />);
};

describe("/portfolio Share-PnL card data", () => {
  it("offers the card only for a cached entry — derived and unknown entries get none", () => {
    renderRows([row("SlabCache11111", "cache"), row("SlabDerived111", "derived"), row("SlabUnknown111", "unknown")]);
    expect([...h.shared.keys()]).toEqual(["SlabCache11111"]);
  });

  it("passes mainnet_ca (not the devnet mint) when there is no logo_url, and asks for live slab capacity", () => {
    renderRows([row("SlabCache11111", "cache")]);
    const { data, liveSlabCapacity } = h.shared.get("SlabCache11111")!;
    const d = data as PnlCardData;
    expect(d.logoUrl).toBeNull();
    expect(d.mainnetCa).toBe("MainnetCaSol111");
    expect(JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("DevnetMint111");
    expect(liveSlabCapacity).toBe(true);
  });

  it("passes logo_url when the market has one", () => {
    renderRows([row("SlabLogo111111", "cache")]);
    expect((h.shared.get("SlabLogo111111")!.data as PnlCardData).logoUrl).toBe("https://cdn.example/sol.png");
  });
});
