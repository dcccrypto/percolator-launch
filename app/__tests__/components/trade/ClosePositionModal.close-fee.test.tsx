/**
 * #3726: the modal (used by the dock, /portfolio and other-market rows) hands the form the whole close-fee estimate for its market.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const est = vi.hoisted(() => ({ calls: [] as Array<[bigint, bigint, bigint]> }));
vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useCloseFeeEstimate", () => ({
  useCloseFeeEstimate: (pos: bigint, base: bigint, mark: bigint) => {
    est.calls.push([pos, base, mark]);
    return () => 71n;
  },
}));

import { ClosePositionModal } from "@/components/trade/ClosePositionModal";

describe("ClosePositionModal close fee (#3726)", () => {
  it("passes the market's close-fee estimate to the form: the fee row is the whole fee, marked (est.)", () => {
    render(
      <ClosePositionModal
        positionSize={1_777_000_000n} entryPrice={1_000_000n} currentPrice={1_000_000n} capital={500_000_000n}
        symbol="TEST" collateralSymbol="USDC" decimals={6} priceUsd={1} isLong loading={false} tradingFeeBps={30n}
        onConfirm={vi.fn()} onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Trading Fee (est.):")).toBeTruthy();
    expect(screen.getByText(/12\.972/)).toBeTruthy();
    expect(est.calls.at(-1)).toEqual([1_777_000_000n, 30n, 1_000_000n]);
  });
});
