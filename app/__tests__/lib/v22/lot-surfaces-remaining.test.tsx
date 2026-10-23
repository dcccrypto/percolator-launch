/**
 * Review N1/N2, remaining surfaces: ChartPnlBadge, FundingRateCard, MarketStatsCard, MarketBrowser (LotOpenInterest) and
 * the markets-page on-chain fallback price (resolveDiscoveredPriceE6). Each at lotExp 3 with a lotExp 0 control.
 */
import "@testing-library/jest-dom";
import fs from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetLotRegistryForTest, observeLotExp } from "@/lib/v22/lot-registry";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, ACCOUNT_KIND } from "@/lib/v22/sdk";

const OWNER = new PublicKey("11111111111111111111111111111111");
function marketBytes(lotExp: number): Uint8Array {
  const L = LAYOUT_V22;
  const d = new Uint8Array(L.marketGroupOff + L.marketGroupLen + L.assetSlotStride);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, L.version, true);
  d[10] = ACCOUNT_KIND.Market;
  d[L.marketGroupOff + L.marketGroupLen + L.wrapperSlot.profileLotExp] = lotExp;
  return d;
}

const h = vi.hoisted(() => ({ raw: null as Uint8Array | null, shared: [] as unknown[] }));
vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => ({ idx: 0, account: { owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n, entryPrice: 0n, adlABasis: 1_000_000_000_000_000n } }),
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 2_000_000n, priceUsd: 2 }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    config: { collateralMint: OWNER },
    params: { initialMarginBps: 1000n },
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
    raw: h.raw,
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "TOK-PERP", name: "Tok", logo_url: null, mainnet_ca: null } }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, insuranceBalance: 0n }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));
vi.mock("@/lib/entry-price", () => ({ getEntryPrice: () => 1_000_000n }));
vi.mock("@/components/share/PnlShareButton", () => ({
  PnlShareButton: ({ data }: { data: unknown }) => {
    h.shared.push(data);
    return <button>Share</button>;
  },
}));

import { ChartPnlBadge } from "@/components/trade/ChartPnlBadge";
import { LotOpenInterest } from "@/components/market/LotOpenInterest";
import { resolveDiscoveredPriceE6 } from "@/lib/discovered-price";
import type { PnlCardData } from "@/lib/pnl-card";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

beforeEach(() => {
  __resetLotRegistryForTest();
  __setDevnetV22ForTest(true);
  h.shared = [];
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

describe("ChartPnlBadge", () => {
  it("lotExp 3: the share card carries the exponent (so it shows per-token prices); lotExp 0 control: none", () => {
    h.raw = marketBytes(3);
    render(<ChartPnlBadge slabAddress="S" />);
    expect((h.shared[h.shared.length - 1] as PnlCardData).lotExp).toBe(3);
    cleanup();
    h.shared = [];
    h.raw = marketBytes(0);
    render(<ChartPnlBadge slabAddress="S" />);
    expect((h.shared[h.shared.length - 1] as PnlCardData).lotExp).toBeUndefined();
  });
});

describe("MarketBrowser open interest (LotOpenInterest)", () => {
  it("lotExp 3: 2 lots of OI show as 2000 tokens; lotExp 0 control: 2; unknown exponent: '--'", () => {
    observeLotExp("A", marketBytes(3));
    render(<LotOpenInterest slab="A" oiQ={2_000_000n} decimals={6} />);
    expect(document.body.textContent).toContain("2000");
    cleanup();
    observeLotExp("B", marketBytes(0));
    const r = render(<LotOpenInterest slab="B" oiQ={2_000_000n} decimals={6} />);
    expect(r.container.textContent).toBe("2");
    cleanup();
    const u = render(<LotOpenInterest slab="NEVER-READ" oiQ={2_000_000n} decimals={6} />);
    expect(u.container.textContent).toBe("--");
  });
});

describe("markets page on-chain fallback price (resolveDiscoveredPriceE6)", () => {
  const oc = { configV17: { markEwmaE6: 60_000_000n, invert: 0 } } as unknown as Parameters<typeof resolveDiscoveredPriceE6>[0];
  it("lotExp 3: the per-lot mark is shown per token; lotExp 0 control: unchanged; unknown: no price", () => {
    expect(resolveDiscoveredPriceE6(oc, 3)).toBe(60_000n);
    expect(resolveDiscoveredPriceE6(oc, 0)).toBe(60_000_000n);
    expect(resolveDiscoveredPriceE6(oc, null)).toBe(0n);
  });
});

describe("source guards (components that need providers to render)", () => {
  const sites: Array<[string, RegExp]> = [
    ["components/trade/FundingRateCard.tsx", /qToTokenQ\(absPosition, lotExpOf\(raw\)\)/],
    ["components/trade/MarketStatsCard.tsx", /lotPriceToTokenE6\(markPriceE6, lotExp\)/],
    ["components/trade/MarketStatsCard.tsx", /lotPriceToTokenE6\(indexPriceE6, lotExp\)/],
    ["components/trade/MarketStatsCard.tsx", /lotPriceToTokenE6\(markPriceE6 - indexPriceE6, lotExp\)/],
    ["components/market/MarketBrowser.tsx", /<LotOpenInterest slab=\{slab\} oiQ=\{m\.engine\.totalOpenInterest\}/],
    ["app/markets/page.tsx", /resolveDiscoveredPriceE6\(m\.onChain, lotOf\(m\.onChain\)\)/],
  ];
  it.each(sites)("%s %#", (file, re) => expect(src(file)).toMatch(re));
});
