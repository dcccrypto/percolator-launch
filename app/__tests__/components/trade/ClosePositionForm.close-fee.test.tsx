/**
 * #3726: the close preview's "Trading Fee" and "Est. Account Balance After" use the whole close fee when the caller passes the estimate.
 * Devnet example from the issue: a 1,777 USDC close showed a 5.33 USDC fee (30 bps base) and was charged 12.62 USDC (~71 bps).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";

const USDC = 1_000_000n;
// 1,777 units at $1.00: a 1,777 USDC close notional. Entry = mark, so the closed part's PnL is 0 and the balance moves by the fee only.
const props = {
  positionSize: 1_777n * USDC,
  entryPrice: 1_000_000n,
  currentPrice: 1_000_000n,
  capital: 500n * USDC,
  symbol: "TEST",
  collateralSymbol: "USDC",
  decimals: 6,
  priceUsd: 1,
  isLong: true,
  loading: false,
  tradingFeeBps: 30n,
  onConfirm: () => {},
};

describe("ClosePositionForm fee preview (#3726)", () => {
  it("CONTROL (the old preview): base fee only, 5.331 USDC", () => {
    render(<ClosePositionForm {...props} />);
    expect(screen.getByText("Trading Fee:")).toBeTruthy();
    expect(screen.getAllByText(/5\.331/).length).toBeGreaterThan(0);
  });

  it("with the close-fee estimate: the whole fee, labelled (est.), and the balance after reflects it", () => {
    render(<ClosePositionForm {...props} closeFeeBpsFor={() => 71n} />);
    expect(screen.getByText("Trading Fee (est.):")).toBeTruthy();
    expect(screen.getAllByText(/12\.616/).length).toBeGreaterThan(0); // 1,777 x 71 bps
    expect(screen.getByText(/487\.38/)).toBeTruthy(); // 500 - 12.6167
  });

  it("the estimate is asked for the size being closed (the default is a 100% close)", () => {
    const asked: bigint[] = [];
    render(<ClosePositionForm {...props} closeFeeBpsFor={(q) => { asked.push(q); return 71n; }} />);
    expect(asked).toContain(1_777n * USDC);
  });

  it("an estimate below the base fee never lowers the fee", () => {
    render(<ClosePositionForm {...props} closeFeeBpsFor={() => 0n} />);
    expect(screen.getByText("Trading Fee:")).toBeTruthy();
    expect(screen.getAllByText(/5\.331/).length).toBeGreaterThan(0);
  });
});
