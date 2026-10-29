/**
 * #3534: the close form's "Est. Account Balance After" is `capital + the closed part's PnL - fee`. On the device a position was opened
 * from, the entry is the cached fill price, so a loss a settle already moved out of `capital` was taken out a second time.
 * One long unit, fill $100, price $90, settled: capital $10, pnl 0. Closing it leaves $10 (no fee), not $0.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";

const props = {
  variant: "modal" as const,
  positionSize: 1_000_000n,
  entryPrice: 100_000_000n,
  currentPrice: 90_000_000n,
  capital: 10_000_000n,
  symbol: "TEST",
  decimals: 6,
  priceUsd: 90,
  isLong: true,
  loading: false,
  onConfirm: () => {},
  onCancel: () => {},
};
const balanceLine = (c: HTMLElement): string => {
  const t = c.textContent ?? "";
  const i = t.indexOf("Est. Account Balance After");
  expect(i).toBeGreaterThan(-1);
  return t.slice(i, i + 60);
};

describe("ClosePositionForm balance-after on a settled loss (#3534)", () => {
  it("with the risk entry, closing a settled leg leaves the $10 the account holds", () => {
    const { container } = render(<ClosePositionForm {...props} riskEntryPrice={90_000_000n} />);
    expect(balanceLine(container)).toMatch(/:~10 TEST/);
    // the PnL row is still the honest since-entry figure (a $10 loss), not zeroed
    expect(container.textContent).toMatch(/Est\. PnL[^A-Za-z]*-?\$?10/);
  });
  it("CONTROL (old behaviour, no risk entry): the same close reads $0", () => {
    const { container } = render(<ClosePositionForm {...props} />);
    expect(balanceLine(container)).not.toMatch(/:~10 TEST/);
    expect(balanceLine(container)).toMatch(/:~0 TEST/);
  });
  it("CONTROL: an unsettled position (risk entry = fill) is unchanged", () => {
    const { container } = render(<ClosePositionForm {...props} capital={20_000_000n} riskEntryPrice={100_000_000n} />);
    expect(balanceLine(container)).toMatch(/:~10 TEST/);
  });
  it("a risk entry of 0n (unknown) falls back to the display entry", () => {
    const a = render(<ClosePositionForm {...props} riskEntryPrice={0n} />);
    expect(balanceLine(a.container)).toMatch(/:~0 TEST/);
  });
});
