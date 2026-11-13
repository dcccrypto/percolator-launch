/**
 * r10 follow-up (#3817 review MED-1 and LOW-3). Holding rent has no counter, so a trade result on a market that charges it cannot be exact:
 * the result is unknown (nothing recorded, no toast figure) and the close estimate is tagged "excl. holding fee" and never green.
 * LOW-3: the realised ledger moved to a v2 key, so old funding-excluded sums are never shown as "funding included".
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetLotRegistryForTest, holdingFeeMayApply, observeLotExp } from "@/lib/v22/lot-registry";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, ACCOUNT_KIND } from "@/lib/v22/sdk";
import { getRealized, recordRealized, getLastResult } from "@/lib/realized-pnl";
import { computePositionPnl } from "@/lib/position-pnl";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import type { SpreadEstimate } from "@/lib/v22/spread-estimate";

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

describe("holdingFeeMayApply", () => {
  beforeEach(() => { __resetLotRegistryForTest(); __setDevnetV22ForTest(true); });
  afterEach(() => __setDevnetV22ForTest(null));
  it("rent_max != 0: yes; rent_max == 0: no; a market not seen yet: yes (never a guess toward none)", () => {
    observeLotExp("RENT", market(100));
    observeLotExp("PLAIN", market(0));
    expect(holdingFeeMayApply("RENT")).toBe(true);
    expect(holdingFeeMayApply("PLAIN")).toBe(false);
    expect(holdingFeeMayApply("UNSEEN")).toBe(true);
  });
  it("flag off (no v2.2 markets): no", () => {
    __setDevnetV22ForTest(false);
    expect(holdingFeeMayApply("UNSEEN")).toBe(false);
  });
});

describe("realised ledger", () => {
  beforeEach(() => { localStorage.clear(); __resetLotRegistryForTest(); __setDevnetV22ForTest(true); });
  afterEach(() => __setDevnetV22ForTest(null));
  it("a market that charges a holding fee records nothing (result unknown); one that does not records as before", () => {
    observeLotExp("RENT", market(23));
    observeLotExp("PLAIN", market(0));
    recordRealized("W", "RENT", -5n);
    recordRealized("W", "PLAIN", -7n);
    expect(getRealized("W", "RENT")).toBeNull();
    expect(getLastResult("W", "RENT")).toBeNull();
    expect(getRealized("W", "PLAIN")).toBe(-7n);
  });
  it("LOW-3: a sum saved by the old build (v1 key, funding excluded) is never read back", () => {
    observeLotExp("PLAIN", market(0));
    localStorage.setItem("perc:realized:v1:W:PLAIN", "123456");
    localStorage.setItem("perc:realized-last:v1:W:PLAIN", "123456");
    expect(getRealized("W", "PLAIN")).toBeNull();
    expect(getLastResult("W", "PLAIN")).toBeNull();
    recordRealized("W", "PLAIN", 10n);
    expect(getRealized("W", "PLAIN")).toBe(10n);
  });
});

describe("computePositionPnl flags the holding fee", () => {
  const base = { basisQ: 1_000_000n, aBasis: 0n, markE6: 100_000_000n, onChainPnl: 0n, initialMarginBps: 1000n, capital: 1_000_000n, adlApplicable: false, adlFactors: null };
  it("passes the flag through; absent means not excluded", () => {
    expect(computePositionPnl({ ...base, holdingFeeMayApply: true } as never).holdingFeeExcluded).toBe(true);
    expect(computePositionPnl({ ...base } as never).holdingFeeExcluded).toBe(false);
  });
});

describe("close dialog: 'excl. holding fee'", () => {
  const props = {
    positionSize: 7_839_061n, entryPrice: 83_166_841n, riskEntryPrice: 82_918_087n, currentPrice: 95_000_000n, capital: 1_000_000_000n,
    symbol: "SOL", collateralSymbol: "USDC", decimals: 6, priceUsd: 95, isLong: true, loading: false, tradingFeeBps: 30n,
    closeFeeBpsFor: () => 52n, spreadEstimateFor: (): SpreadEstimate => ({ kind: "quote", bps: 22, execPriceE6: null, inFee: true }),
    onConfirm: () => {}, busyOpenFeeAtoms: 0n, fundingPaidAtoms: 0n,
  };
  it("on a market that may charge it: tagged and a clear profit is NOT green", () => {
    render(<ClosePositionForm {...props} holdingFeeExcluded />);
    expect(screen.getByTestId("close-net-excl-holding")).toHaveTextContent("excl. holding fee");
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "positive");
    expect(net.className).not.toContain("--long");
  });
  it("otherwise: no tag and a profit is green as before", () => {
    render(<ClosePositionForm {...props} />);
    expect(screen.queryByTestId("close-net-excl-holding")).toBeNull();
    expect(screen.getByTestId("close-net-result").className).toContain("--long");
  });
});
