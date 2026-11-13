/**
 * Review of #3821 (LOW-1, LOW-2, LOW-3): the holding-fee flag must reach every surface, and must arrive together with the lot exponent.
 *  LOW-1: portfolioPositionPnl / terminalPositionPnl forward the registry flag; ClosePositionModal and OrderTicketClosePanel pass the prop on.
 *  LOW-2: a market whose band config cannot be read is "may apply", never "none".
 *  LOW-3: the loader path (LotExpLoaderBridge) sets the flag through observeLotExp, not only the exponent.
 */
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const conn = vi.hoisted(() => ({ data: null as Uint8Array | null, calls: 0 }));
vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const connection = { getAccountInfo: async () => { conn.calls++; return conn.data ? { data: conn.data } : null; } };
  return { ...(await orig<object>()), useConnectionCompat: () => ({ connection }) };
});
vi.mock("@/hooks/useSpreadQuoter", () => ({
  useSpreadQuoter: () => (() => ({ kind: "quote", bps: 22, execPriceE6: null, inFee: true })),
}));
vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), prewarmClose: vi.fn(), loading: false, error: null }),
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 95_000_000n, priceUsd: 95 }) }));
vi.mock("@/hooks/useCloseFeeEstimate", () => ({ useCloseFeeEstimate: () => () => 52n }));

import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetLotRegistryForTest, ensureLotExp, getLotExp, holdingFeeMayApply, lotExpOfStrict, observeLotExp } from "@/lib/v22/lot-registry";
import { LotExpLoaderBridge } from "@/components/v22/LotExpLoaderBridge";
import { LAYOUT_V21, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, ACCOUNT_KIND } from "@/lib/v22/sdk";
import { portfolioPositionPnl, terminalPositionPnl } from "@/lib/position-pnl";
import { ClosePositionModal } from "@/components/trade/ClosePositionModal";
import { OrderTicketClosePanel } from "@/components/trade/OrderTicketClosePanel";

const L = LAYOUT_V22;
function market(rentMax: number): Uint8Array {
  const d = new Uint8Array(L.marketGroupOff + L.marketGroupLen + L.assetSlotStride);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, L.version, true);
  d[10] = ACCOUNT_KIND.Market;
  v.setBigUint64(L.marketGroupOff + L.group.config + L.bandRent!.config.rentMaxE9PerSlot, BigInt(rentMax), true);
  return d;
}
/** A v2.1 market (VERSION 18): a readable lot exponent, but no band / rent words. */
function market21(): Uint8Array {
  const d = new Uint8Array(Math.max(LAYOUT_V21.marketGroupOff + LAYOUT_V21.marketGroupLen + LAYOUT_V21.assetSlotStride, L.marketGroupOff + L.marketGroupLen + L.assetSlotStride));
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V21.version, true);
  d[10] = ACCOUNT_KIND.Market;
  return d;
}

beforeEach(() => { __resetLotRegistryForTest(); __setDevnetV22ForTest(true); conn.data = null; conn.calls = 0; });
afterEach(() => __setDevnetV22ForTest(null));

describe("LOW-3: the loader path sets the holding-fee flag with the exponent", () => {
  it("a slab known only through the loader: rent_max 0 -> no holding fee, rent_max != 0 -> may apply, exponent known in both", async () => {
    render(<LotExpLoaderBridge />);
    // The bridge imports the registry lazily (keeps the SDK out of the root layout's first load): let the install land.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const PLAIN = "11111111111111111111111111111111";
    const RENT = "So11111111111111111111111111111111111111112";
    conn.data = market(0);
    ensureLotExp(PLAIN);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(getLotExp(PLAIN)).not.toBeNull();
    expect(holdingFeeMayApply(PLAIN)).toBe(false); // before the fix the flag was never set here: "may apply" for every loader-only market
    conn.data = market(100);
    ensureLotExp(RENT);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(getLotExp(RENT)).not.toBeNull();
    expect(holdingFeeMayApply(RENT)).toBe(true);
  });
});

describe("LOW-2: an unreadable market config is 'may apply', never 'none'", () => {
  it("a v2.1 layout has a readable exponent but no band / rent words", () => {
    const bytes = market21();
    expect(lotExpOfStrict(bytes)).not.toBeNull(); // the precondition: the exponent decodes, the config does not
    observeLotExp("OLD", bytes);
    expect(getLotExp("OLD")).not.toBeNull();
    expect(holdingFeeMayApply("OLD")).toBe(true);
  });
  it("a market first seen as plain and then re-read with an unreadable config falls back to 'may apply'", () => {
    observeLotExp("M", market(0));
    expect(holdingFeeMayApply("M")).toBe(false);
    observeLotExp("M", market21());
    expect(holdingFeeMayApply("M")).toBe(true);
  });
});

describe("LOW-1: the adapters forward the registry flag", () => {
  const account = { positionSize: 1_000_000n, adlABasis: 0n, pnl: 0n, capital: 1_000_000_000n, owner: { toBase58: () => "W" } };
  const portfolio = (slab: string) => ({
    account, adlFactors: null, adlApplicable: false, effectiveEntryPrice: 90_000_000n, entryPriceSource: "cache" as const,
    initialMarginBps: 1000n, oraclePriceE6: 95_000_000n, slabAddress: slab, idx: 0,
  });
  const terminal = (slab: string) => ({
    account, slabAddress: slab, accountIdx: 0, adlFactors: null, adlApplicable: false, markE6: 95_000_000n, initialMarginBps: 1000n,
  });
  beforeEach(() => { observeLotExp("RENT", market(100)); observeLotExp("PLAIN", market(0)); });

  it("portfolioPositionPnl: rent market true, plain false, unseen true", () => {
    expect(portfolioPositionPnl(portfolio("RENT"), null).holdingFeeExcluded).toBe(true);
    expect(portfolioPositionPnl(portfolio("PLAIN"), null).holdingFeeExcluded).toBe(false);
    expect(portfolioPositionPnl(portfolio("UNSEEN"), null).holdingFeeExcluded).toBe(true);
  });
  it("terminalPositionPnl: rent market true, plain false, unseen true", () => {
    expect(terminalPositionPnl(terminal("RENT")).holdingFeeExcluded).toBe(true);
    expect(terminalPositionPnl(terminal("PLAIN")).holdingFeeExcluded).toBe(false);
    expect(terminalPositionPnl(terminal("UNSEEN")).holdingFeeExcluded).toBe(true);
  });
});

describe("LOW-1: the dialogs pass the prop on to the form", () => {
  const modalProps = {
    positionSize: 7_839_061n, entryPrice: 83_166_841n, riskEntryPrice: 82_918_087n, currentPrice: 95_000_000n, capital: 1_000_000_000n,
    symbol: "SOL", collateralSymbol: "USDC", decimals: 6, priceUsd: 95, isLong: true, loading: false, tradingFeeBps: 30n,
    busyOpenFeeAtoms: 0n, fundingPaidAtoms: 0n, onConfirm: vi.fn(), onCancel: vi.fn(),
  };
  it("ClosePositionModal: holdingFeeExcluded shows the tag; without it there is none", () => {
    const { unmount } = render(<ClosePositionModal {...modalProps} holdingFeeExcluded />);
    expect(screen.getByTestId("close-net-excl-holding")).toBeInTheDocument();
    unmount();
    render(<ClosePositionModal {...modalProps} />);
    expect(screen.queryByTestId("close-net-excl-holding")).toBeNull();
  });
  const panel = (extra: object) => (
    <OrderTicketClosePanel
      slabAddress="Slab111" positionSize={7_839_061n} entryPriceE6={83_166_841n} capital={1_000_000_000n}
      symbol="SOL" collateralSymbol="USDC" decimals={6} tradingFeeBps={30n} maxFillAbs={null}
      lpUnderfunded={false} engineStale={false} oracleBlocked={false} onClosed={vi.fn()} busyOpenFeeAtoms={0n} fundingPaidAtoms={0n} {...extra}
    />
  );
  it("OrderTicketClosePanel (the dock's Close tab): the same", () => {
    const { unmount } = render(panel({ holdingFeeExcluded: true }));
    expect(screen.getByTestId("close-net-excl-holding")).toBeInTheDocument();
    unmount();
    render(panel({}));
    expect(screen.queryByTestId("close-net-excl-holding")).toBeNull();
  });
});
