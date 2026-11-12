/**
 * r8 Council: the close dialogs lead with the NET result (mark-to-market PnL from the fill entry, less the closing fee incl. spread and,
 * since r9, less the base fee paid when the closed part was opened, so it equals the realised trade result). The gross
 * line is secondary. "Profit becomes withdrawable" shows only for a positive net; the loading fee estimate shows no optimistic number.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import type { SpreadEstimate } from "@/lib/v22/spread-estimate";

const USDC = 1_000_000n;
const props = {
  positionSize: 1_000n * USDC, // 1,000 units
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
const loaded = (): SpreadEstimate => ({ kind: "quote", bps: 70, execPriceE6: null, inFee: true });

describe("close dialog: net result after closing fees", () => {
  it("a long whose mark is just above the entry but whose closing fee exceeds the gain: negative net, red, no profit line", () => {
    // gross +1.00 (1,000 x +0.1%), close fee 100 bps of 1,001 = 10.01, opening base fee 30 bps of 1,000 = 3 -> net -12.01
    render(<ClosePositionForm {...props} currentPrice={1_001_000n} spreadEstimateFor={loaded} closeFeeBpsFor={() => 100n} />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "negative");
    expect(net.textContent).toMatch(/^-12\.0\d+ USDC/);
    expect(net.className).toContain("--short");
    expect(screen.getByText("Est. result if closed now:")).toBeInTheDocument();
    expect(screen.getByText("Est. PnL (before closing fees):")).toBeInTheDocument();
    expect(screen.getByTestId("close-gross-pnl").textContent).toMatch(/^\+1 USDC/);
    expect(screen.getByTestId("close-gross-pnl").className).not.toContain("--long");
    // the gross +1.00 is still a profit that has to settle, whatever the net says
    expect(screen.getByTestId("close-profit-settles")).toBeInTheDocument();
  });

  it("a clear winner: positive net, green, with the profit line", () => {
    // gross +100, close fee (30 base + 70 spread) bps of 1,100 = 11, opening base fee 3 -> net +86
    render(<ClosePositionForm {...props} currentPrice={1_100_000n} spreadEstimateFor={loaded} />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "positive");
    expect(net.textContent).toMatch(/^\+86 USDC/);
    expect(net.className).toContain("--long");
    expect(screen.getByTestId("close-profit-settles")).toBeInTheDocument();
  });

  it("loading: the fee estimate has not answered, so no net figure (and no profit line) is shown", () => {
    render(<ClosePositionForm {...props} currentPrice={1_100_000n} spreadEstimateFor={() => null} />);
    expect(screen.queryByTestId("close-net-result")).toBeNull();
    expect(screen.getByTestId("close-net-loading").textContent).toBe("--");
    expect(screen.getByTestId("close-profit-settles")).toBeInTheDocument(); // keyed on the gross PnL, which is known
  });

  it("an unknown entry shows no net figure", () => {
    render(<ClosePositionForm {...props} entryPrice={0n} spreadEstimateFor={loaded} />);
    expect(screen.queryByTestId("close-net-result")).toBeNull();
    expect(screen.getByTestId("close-net-unknown")).toBeInTheDocument();
  });

  it("a short that gains: positive net after the closing fee", () => {
    // short 1,000 units, entry 1.00, mark 0.90: gross +100, close fee 100 bps of 900 = 9, opening fee 3 -> +88
    render(<ClosePositionForm {...props} positionSize={-1_000n * USDC} isLong={false} currentPrice={900_000n} spreadEstimateFor={loaded} />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "positive");
    expect(net.textContent).toMatch(/^\+88 USDC/);
  });

  it("a short that loses on the mark: negative net, red", () => {
    render(<ClosePositionForm {...props} positionSize={-1_000n * USDC} isLong={false} currentPrice={1_050_000n} spreadEstimateFor={loaded} />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "negative");
    expect(net.className).toContain("--short");
  });

  it("a partial close (50%) uses half the PnL and the fee on half the notional, and shows no profit line", () => {
    // 50%: gross +50, close fee 100 bps of 550 = 5.5, opening fee on half = 1.5 -> +43
    render(<ClosePositionForm {...props} currentPrice={1_100_000n} spreadEstimateFor={loaded} />);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(screen.getByTestId("close-net-result").textContent).toMatch(/^\+43 USDC/);
    expect(screen.queryByTestId("close-profit-settles")).toBeNull();
  });

  it("loading on a partial close still shows no number", () => {
    render(<ClosePositionForm {...props} currentPrice={1_100_000n} spreadEstimateFor={() => null} />);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(screen.queryByTestId("close-net-result")).toBeNull();
    expect(screen.getByTestId("close-net-loading")).toBeInTheDocument();
  });

  it("a coin-margined market: the net is in the collateral coin, the same unit as the fee row", () => {
    render(<ClosePositionForm {...props} collateralSymbol="SOL" currentPrice={1_100_000n} spreadEstimateFor={loaded} />);
    expect(screen.getByTestId("close-net-result").textContent).toMatch(/ SOL$/);
    expect(screen.getByTestId("close-net-result").textContent).not.toMatch(/USDC/);
    expect(screen.getByText("Trading Fee (est.):").parentElement?.textContent).toMatch(/SOL/);
  });

  it("a near-zero net reads neutral 0.00, never a red -0.00", () => {
    // half a unit at the entry price: no PnL, close fee 0.0015 + opening fee 0.0015 = 0.003 -> inside half a cent
    render(<ClosePositionForm {...props} positionSize={USDC / 2n} spreadEstimateFor={() => ({ kind: "quote", bps: 0, execPriceE6: null, inFee: false })} />);
    const net = screen.getByTestId("close-net-result");
    expect(net.textContent).toBe("0.00 USDC");
    expect(net).toHaveAttribute("data-sign", "zero");
    expect(net.className).not.toContain("--short");
    expect(net.className).not.toContain("--long");
  });

  it("when the fill entry and the account's risk entry differ, a helper line explains the two rows", () => {
    render(<ClosePositionForm {...props} riskEntryPrice={900_000n} spreadEstimateFor={loaded} />);
    expect(screen.getByTestId("close-net-basis")).toBeInTheDocument();
  });
  it("no helper line when the entries agree", () => {
    render(<ClosePositionForm {...props} riskEntryPrice={1_000_000n} spreadEstimateFor={loaded} />);
    expect(screen.queryByTestId("close-net-basis")).toBeNull();
  });

  // r9 LOW-1: a quoter that failed / is unavailable never answers, so "loading" would show "--" forever.
  const unavailable = Object.assign(() => null, { unavailable: true });
  it("an unavailable spread quoter shows the net from the base-fee estimate, labelled excl. spread, and neutral for a gain", () => {
    // gross +100, base close fee 30 bps of 1,100 = 3.3, opening fee 3 -> +93.7
    render(<ClosePositionForm {...props} currentPrice={1_100_000n} spreadEstimateFor={unavailable} />);
    expect(screen.queryByTestId("close-net-loading")).toBeNull();
    const net = screen.getByTestId("close-net-result");
    expect(net.textContent).toMatch(/^\+93\.7 USDC/);
    expect(screen.getByTestId("close-net-excl-spread").textContent).toMatch(/excl\. spread/);
    expect(net.className).not.toContain("--long");
  });
  it("an unavailable quoter on a loss is red (never green) and labelled", () => {
    render(<ClosePositionForm {...props} currentPrice={900_000n} spreadEstimateFor={unavailable} />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "negative");
    expect(net.className).toContain("--short");
    expect(screen.getByTestId("close-net-excl-spread")).toBeInTheDocument();
  });
  it("a loaded quote carries no excl. spread label", () => {
    render(<ClosePositionForm {...props} currentPrice={1_100_000n} spreadEstimateFor={loaded} />);
    expect(screen.queryByTestId("close-net-excl-spread")).toBeNull();
  });

  // r9 LOW-2: the settle note follows the gross PnL (what settles), not the net.
  it("no profit-settles note when the gross PnL is a loss, even with a full close", () => {
    render(<ClosePositionForm {...props} currentPrice={900_000n} spreadEstimateFor={loaded} />);
    expect(screen.queryByTestId("close-profit-settles")).toBeNull();
  });

  // r9 LOW-3: the near-zero band is half a cent of USD value on a coin-collateral market.
  it("9-decimal coin collateral: a -0.003 SOL net (about $0.45) is shown, not hidden as 0.00", () => {
    render(
      <ClosePositionForm
        {...props}
        symbol="SOL"
        collateralSymbol="SOL"
        decimals={9}
        priceUsd={150}
        positionSize={1_000_000_000n}
        capital={5_000_000_000n}
        spreadEstimateFor={() => ({ kind: "quote", bps: 0, execPriceE6: null, inFee: false })}
      />,
    );
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "negative");
    expect(net.textContent).not.toMatch(/^0\.00 /);
  });
  it("9-decimal coin collateral: a net under half a cent of USD still reads 0.00", () => {
    render(
      <ClosePositionForm
        {...props}
        symbol="SOL"
        collateralSymbol="SOL"
        decimals={9}
        priceUsd={150}
        positionSize={1_000_000n}
        capital={5_000_000_000n}
        spreadEstimateFor={() => ({ kind: "quote", bps: 0, execPriceE6: null, inFee: false })}
      />,
    );
    expect(screen.getByTestId("close-net-result").textContent).toBe("0.00 SOL");
  });

  it("r9: a mark just above the closing break-even but below the opening fee too reads RED: the whole trade loses", () => {
    // gross +11.5 (mark 1.0115), close fee 100 bps of 1,011.5 = 10.115 -> old net +1.385 (green); less the 3 opening fee -> -1.615
    render(<ClosePositionForm {...props} currentPrice={1_011_500n} spreadEstimateFor={loaded} closeFeeBpsFor={() => 100n} />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "negative");
    expect(net.textContent).toMatch(/^-1\.61\d* USDC/);
    expect(net.className).toContain("--short");
    expect(screen.getByTestId("close-open-fee").textContent).toMatch(/−3 USDC/);
  });
  it("r9: the opening fee uses the booked (risk) entry it was charged on", () => {
    // fill entry 1.00, booked 0.99: opening fee 30 bps of 990 = 2.97
    render(<ClosePositionForm {...props} riskEntryPrice={990_000n} currentPrice={1_100_000n} spreadEstimateFor={loaded} />);
    expect(screen.getByTestId("close-open-fee").textContent).toMatch(/−2\.97 USDC/);
    expect(screen.getByTestId("close-net-result").textContent).toMatch(/^\+86\.03 USDC/);
  });
});
