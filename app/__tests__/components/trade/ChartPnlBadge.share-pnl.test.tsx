/**
 * The chart's PnL badge carries a Share-PnL button for THIS market's open
 * position. The REAL badge builds the card data; PnlShareButton is a probe that
 * records it. Mirrors PositionsDock.share-pnl: identity from the market row,
 * entry from the on-chain/cached value (never a derived estimate, even when the
 * badge itself renders from one), pool capacity from vault + insurance, and no
 * button at all when there's no open position or no recorded entry.
 */
import "@testing-library/jest-dom";
import { render, screen, cleanup } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as unknown,
  priceE6: 2_000_000n as bigint | null, // $2.00 mark
  entry: 1_000_000n as bigint, // $1.00 cached entry
  market: null as Record<string, unknown> | null,
  insurance: 0n as bigint | null,
  shared: [] as unknown[],
}));

const OWNER = new PublicKey("11111111111111111111111111111111");
const acct = (over: Record<string, unknown>) => ({
  idx: 0,
  account: {
    owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n,
    entryPrice: 0n, adlABasis: 1_000_000_000_000_000n,
    ...over,
  },
});

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account }));
vi.mock("@/hooks/useLivePrice", () => ({
  useLivePrice: () => ({ priceE6: h.priceE6, priceUsd: h.priceE6 === null ? null : Number(h.priceE6) / 1e6 }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    config: { collateralMint: OWNER },
    params: { initialMarginBps: 1000n },
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: h.market }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, insuranceBalance: h.insurance }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));
vi.mock("@/lib/entry-price", () => ({ getEntryPrice: () => h.entry }));

vi.mock("@/components/share/PnlShareButton", () => ({
  PnlShareButton: ({ data }: { data: unknown }) => {
    h.shared.push(data);
    return data ? <button>Share</button> : null;
  },
}));

import { ChartPnlBadge } from "@/components/trade/ChartPnlBadge";
import type { PnlCardData } from "@/lib/pnl-card";

const SLAB = "SLAB1111111111111111111111111111111111111111";
const lastShared = () => h.shared[h.shared.length - 1] as PnlCardData | null;

beforeEach(() => {
  h.priceE6 = 2_000_000n;
  h.entry = 1_000_000n;
  h.account = acct({});
  h.market = { symbol: "JIMOTHY-PERP", name: "Jimothy", logo_url: "https://logo.example/j.png", mainnet_ca: "CA_MAINNET_111" };
  h.insurance = 7_000_000n;
  h.shared = [];
});
afterEach(cleanup);

describe("ChartPnlBadge — Share PnL", () => {
  it("renders the Share button and hands the card honest, market-sourced data", () => {
    render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();

    const d = lastShared();
    expect(d).not.toBeNull();
    expect(d!.slab).toBe(SLAB);
    expect(d!.symbol).toBe("JIMOTHY"); // "-PERP" stripped
    expect(d!.name).toBe("Jimothy");
    expect(d!.logoUrl).toBe("https://logo.example/j.png");
    expect(d!.mainnetCa).toBe("CA_MAINNET_111"); // the market row, never the devnet mint
    expect(d!.entryE6).toBe(1_000_000n); // the cached entry, not a derived estimate
    expect(d!.nominalSizeQ).toBe(40_000_000n);
    expect(d!.effectiveSizeQ).toBe(40_000_000n); // no ADL → equals nominal
    expect(d!.initialMarkE6).toBe(2_000_000n);
    expect(d!.payableCapacityAtoms).toBe(7_000_000n); // vault(0) + insurance(7)
  });

  it("renders nothing when there is no open position", () => {
    h.account = acct({ positionSize: 0n });
    render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(lastShared()).toBeUndefined(); // the badge returned before building data
  });

  it("never offers a card on a cache miss, even when on-chain pnl could back-solve an entry", () => {
    // No cached entry, but a non-zero on-chain pnl: resolveEntryPrice would
    // return a "derived" entry here (40e6 atoms over a 40e6-q long at $2.00
    // back-solves to $1.00). Whether or not the badge itself renders from that
    // estimate (#2990), the share card must not publish it — only the entry
    // recorded at open is shareable, same as the dock.
    h.entry = 0n;
    h.account = acct({ pnl: 40_000_000n });
    render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(h.shared.filter((d) => d !== null)).toEqual([]); // no card data built from it
  });

  it("CONTROL: the same position WITH a cached entry is shareable at that entry", () => {
    h.entry = 1_000_000n;
    h.account = acct({ pnl: 40_000_000n });
    render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(lastShared()!.entryE6).toBe(1_000_000n);
  });

  it("renders nothing when no entry is known (on-chain 0 and nothing cached)", () => {
    h.entry = 0n; // no cached entry; account.entryPrice is 0n too
    render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  });
});
