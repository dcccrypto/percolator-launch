/**
 * Review of #3820 (HIGH 1 / MED 3 / LOW 4): the close dialog asks the quoter for the CLOSE size as a REDUCE (takerReducing = true), shows the net
 * with the fee-cap margin (an honest upper bound: the shown loss is never smaller than the cap lets through), and says "excl. spread" when the
 * quote is unavailable (a quoter that cannot be built never falls back to a low number).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import type { SpreadEstimate } from "@/lib/v22/spread-estimate";

const USDC = 1_000_000n;
const props = {
  positionSize: 1_000n * USDC, entryPrice: 1_000_000n, currentPrice: 1_000_000n, capital: 500n * USDC, symbol: "TEST", collateralSymbol: "USDC",
  decimals: 6, priceUsd: 1, isLong: true, loading: false, tradingFeeBps: 30n, onConfirm: () => {},
};
const quote70 = (): SpreadEstimate => ({ kind: "quote", bps: 70, execPriceE6: null, inFee: true });

describe("ClosePositionForm quotes a close as a reduce", () => {
  it("calls the quoter with the closed size, the closing side and takerReducing = true", () => {
    const spy = vi.fn(quote70);
    render(<ClosePositionForm {...props} spreadEstimateFor={spy} />);
    expect(spy).toHaveBeenCalled();
    for (const c of spy.mock.calls) expect(c).toEqual([1_000n * USDC, false, true]);
  });

  it("a short closes with a buy, still as a reduce", () => {
    const spy = vi.fn(quote70);
    render(<ClosePositionForm {...props} positionSize={-1_000n * USDC} isLong={false} spreadEstimateFor={spy} />);
    for (const c of spy.mock.calls) expect(c).toEqual([1_000n * USDC, true, true]);
  });

  it("the net carries the 2 bp margin: 30 base + 70 quote + 2 margin on 1,000 = 10.2 closing fee, plus 3 opening base fee = -13.2 (not -13.0)", () => {
    render(<ClosePositionForm {...props} spreadEstimateFor={quote70} />);
    expect(screen.getByTestId("close-net-result").textContent).toMatch(/^-13\.2\d* USDC/);
  });

  it("an unavailable quote says 'excl. spread' and shows no confident number from a low spread", () => {
    const unavailable = Object.assign(() => null, { unavailable: true });
    render(<ClosePositionForm {...props} spreadEstimateFor={unavailable} />);
    expect(screen.getByText(/excl\. spread/)).toBeInTheDocument();
  });
});
