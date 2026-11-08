/** M7: the close dialog carries its own "Spread / price impact" line and the balance preview pays for it. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";

const USDC = 1_000_000n;
// 40 units at $1.00: entry = mark, so PnL is 0 and the balance moves by fee + spread only.
const props = {
  positionSize: 40n * USDC,
  entryPrice: 1_000_000n,
  currentPrice: 1_000_000n,
  capital: 44n * USDC,
  symbol: "TEST",
  collateralSymbol: "USDC",
  decimals: 6,
  priceUsd: 1,
  isLong: true,
  loading: false,
  tradingFeeBps: 30n,
  onConfirm: () => {},
};

describe("ClosePositionForm spread line (M7)", () => {
  it("CONTROL: with no estimate the row says it is unavailable (never 0%) and the balance is capital - fee", () => {
    render(<ClosePositionForm {...props} />);
    expect(screen.getByTestId("close-spread")).toHaveTextContent(/not available before the trade/i);
    expect(screen.getByTestId("close-spread").textContent).not.toMatch(/0\.00%/);
    expect(screen.getByText(/43\.88/)).toBeInTheDocument(); // 44 - 0.12
  });
  it("channel OFF (N-2): a 23 bps estimate is shown for information; the close books at the mark, so NOTHING is subtracted", () => {
    const asked: Array<[bigint, boolean]> = [];
    render(<ClosePositionForm {...props} spreadEstimateFor={(q, buys) => { asked.push([q, buys]); return { kind: "quote", bps: 23, execPriceE6: null }; }} />);
    expect(screen.getByTestId("close-spread")).toHaveTextContent("Spread / price impact:");
    expect(screen.getByTestId("close-spread")).toHaveTextContent("~0.23% (est., not charged on this market: fills settle at the mark)");
    expect(screen.getByTestId("close-spread").textContent).not.toMatch(/USDC|−0\./);
    expect(screen.getByText(/43\.88/)).toBeInTheDocument(); // 44 - 0.12, unchanged
    expect(asked.every(([, buys]) => buys === false)).toBe(true);
    expect(asked.some(([q]) => q === 40n * USDC)).toBe(true);
  });
  it("closing a SHORT asks for a buy", () => {
    const asked: boolean[] = [];
    render(<ClosePositionForm {...props} positionSize={-40n * USDC} isLong={false} spreadEstimateFor={(_q, buys) => { asked.push(buys); return null; }} />);
    expect(asked.every((b) => b === true)).toBe(true);
  });
  it("M-3: on a fee-channel market the spread is INSIDE the fee row: the row says so and the balance is NOT reduced a second time", () => {
    // the close-fee estimate (#3726) already contains the matcher's requested fee: base 30 + 23 spread bps = 53 bps on 40 = 0.212
    render(<ClosePositionForm {...props} closeFeeBpsFor={() => 53n} spreadEstimateFor={() => ({ kind: "quote", bps: 23, execPriceE6: null, inFee: true })} />);
    const row = screen.getByTestId("close-spread");
    expect(row).toHaveTextContent("~0.23% (est., included in the trading fee)");
    expect(row.textContent).not.toMatch(/−0\./);
    expect(screen.getByText(/43\.788/)).toBeInTheDocument(); // 44 - 0.212 once, not 44 - 0.212 - 0.092
    expect(screen.queryByText(/43\.696/)).toBeNull();
  });

  // F1: the deployed configuration has NEXT_PUBLIC_LIMITS_P2 OFF, so the close fee estimate holds the BASE fee only (30 bps) while the
  // chain charges base + the requested fee. Council close 3fcYeu1m: 223,463 lots at 89.607382 = 20.0248 USDC, charged 102,123 atoms (51 bps).
  const council = {
    ...props,
    positionSize: 223_463n,
    entryPrice: 89_607_382n,
    currentPrice: 89_607_382n,
    priceUsd: 89.607382,
    capital: 7_300_000n,
    decimals: 6,
    tradingFeeBps: 30n,
  };
  it("F1: channel ON but the P2 flag OFF (fee estimate = base 30 bps): the fee row takes the quote's requested bps, so it matches the chain's ~102,123 atoms and the balance is not high", () => {
    render(<ClosePositionForm {...council} closeFeeBpsFor={() => 30n} spreadEstimateFor={() => ({ kind: "quote", bps: 21, execPriceE6: null, inFee: true })} />);
    expect(screen.getByText("Trading Fee (est.):")).toBeInTheDocument();
    expect(screen.getByText(/−0\.1021/)).toBeInTheDocument(); // 51 bps of 20.0248 = 102,126 atoms (chain: 102,123)
    expect(screen.getByTestId("close-spread")).toHaveTextContent("included in the trading fee");
    expect(screen.getByText(/~7\.1978/)).toBeInTheDocument(); // 7.3 - 0.102126; with the base fee alone it would read 7.2399
    expect(screen.queryByText(/7\.2399/)).toBeNull();
  });
  it("F1 CONTROL: the P2 flag ON (the estimate already holds 51 bps): the requested fee is NOT added a second time", () => {
    render(<ClosePositionForm {...council} closeFeeBpsFor={() => 51n} spreadEstimateFor={() => ({ kind: "quote", bps: 21, execPriceE6: null, inFee: true })} />);
    expect(screen.getByText(/−0\.1021/)).toBeInTheDocument();
    expect(screen.getByText(/~7\.1978/)).toBeInTheDocument();
  });
  it("F1: channel OFF: the fee stays the base fee alone (30 bps = 0.0601 USDC)", () => {
    render(<ClosePositionForm {...council} closeFeeBpsFor={() => 30n} spreadEstimateFor={() => ({ kind: "quote", bps: 21, execPriceE6: null })} />);
    expect(screen.getByText("Trading Fee:")).toBeInTheDocument();
    expect(screen.getByText(/−0\.0600/)).toBeInTheDocument();
  });
  it("L-1: the estimate holds MORE than base (53 bps, e.g. P2 on with a busy-side part): the quote's 21 bps is not added on top and not substituted either (53 bps of 20.0248 = 106,131)", () => {
    render(<ClosePositionForm {...council} closeFeeBpsFor={() => 53n} spreadEstimateFor={() => ({ kind: "quote", bps: 21, execPriceE6: null, inFee: true })} />);
    expect(screen.getByText(/−0\.1061/)).toBeInTheDocument();
    expect(screen.queryByText(/−0\.1021/)).toBeNull();
  });
});
