/**
 * r10 live check: a funding read that failed for a moment (devnet RPC 429) showed "excl. funding" with no funding row in the dock close dialog.
 * The last good figure of the SAME position is kept while the figure is read again; "excl. funding" shows only after the hold ends.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { ClosePositionForm, FUNDING_HOLD_MS } from "@/components/trade/ClosePositionForm";

vi.stubEnv("NEXT_PUBLIC_FEE_CAP_MARGIN_BPS", "0");

const props = {
  positionSize: 7_839_061n,
  entryPrice: 83_166_841n,
  riskEntryPrice: 82_918_087n,
  currentPrice: 83_900_000n,
  capital: 1_000_000_000n,
  symbol: "SOL",
  collateralSymbol: "USDC",
  decimals: 6,
  priceUsd: 83.9,
  isLong: true,
  loading: false,
  tradingFeeBps: 30n,
  onConfirm: () => {},
  busyOpenFeeAtoms: 0n,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("close dialog funding: keep the last good value while it is read again", () => {
  it("a read that drops to null keeps the funding row and no tag", () => {
    const { rerender } = render(<ClosePositionForm {...props} fundingPaidAtoms={51_132n} />);
    expect(screen.getByTestId("close-funding").textContent).toContain("0.051132");
    rerender(<ClosePositionForm {...props} fundingPaidAtoms={null} />);
    expect(screen.getByTestId("close-funding").textContent).toContain("0.051132");
    expect(screen.queryByTestId("close-net-excl-funding")).toBeNull();
  });
  it("shows 'excl. funding' once the hold ends (the retries failed)", () => {
    const { rerender } = render(<ClosePositionForm {...props} fundingPaidAtoms={51_132n} />);
    rerender(<ClosePositionForm {...props} fundingPaidAtoms={null} />);
    act(() => {
      vi.advanceTimersByTime(FUNDING_HOLD_MS + 50);
    });
    expect(screen.getByTestId("close-net-excl-funding")).toBeInTheDocument();
    expect(screen.queryByTestId("close-funding")).toBeNull();
  });
  it("a new good value replaces the held one and restarts the hold", () => {
    const { rerender } = render(<ClosePositionForm {...props} fundingPaidAtoms={51_132n} />);
    rerender(<ClosePositionForm {...props} fundingPaidAtoms={60_001n} />);
    rerender(<ClosePositionForm {...props} fundingPaidAtoms={null} />);
    expect(screen.getByTestId("close-funding").textContent).toContain("0.060001");
  });
  it("NEGATIVE: never reuses the value for a different size or position", () => {
    const { rerender } = render(<ClosePositionForm {...props} fundingPaidAtoms={51_132n} />);
    rerender(<ClosePositionForm {...props} positionSize={5_000_000n} fundingPaidAtoms={null} />);
    expect(screen.getByTestId("close-net-excl-funding")).toBeInTheDocument();
    expect(screen.queryByTestId("close-funding")).toBeNull();
    // and it does not come back when the size returns: the old value was dropped
    rerender(<ClosePositionForm {...props} fundingPaidAtoms={null} />);
    expect(screen.getByTestId("close-net-excl-funding")).toBeInTheDocument();
  });
  it("NEGATIVE: a flipped side or entry is another position", () => {
    const { rerender } = render(<ClosePositionForm {...props} fundingPaidAtoms={51_132n} />);
    rerender(<ClosePositionForm {...props} entryPrice={80_000_000n} fundingPaidAtoms={null} />);
    expect(screen.getByTestId("close-net-excl-funding")).toBeInTheDocument();
  });
  it("NEGATIVE: with nothing good to hold, null shows the tag at once", () => {
    render(<ClosePositionForm {...props} fundingPaidAtoms={null} />);
    expect(screen.getByTestId("close-net-excl-funding")).toBeInTheDocument();
  });
});
