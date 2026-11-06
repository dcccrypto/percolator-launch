/**
 * #3726: the order ticket's Close tab hands the inline form the whole close-fee estimate for the market.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const est = vi.hoisted(() => ({ calls: [] as Array<[bigint, bigint, bigint]> }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), prewarmClose: vi.fn(), loading: false, error: null }),
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/hooks/useCloseFeeEstimate", () => ({
  useCloseFeeEstimate: (pos: bigint, base: bigint, mark: bigint) => {
    est.calls.push([pos, base, mark]);
    return () => 71n;
  },
}));

import { OrderTicketClosePanel } from "@/components/trade/OrderTicketClosePanel";

describe("OrderTicketClosePanel close fee (#3726)", () => {
  it("the Close tab's fee row is the whole close fee, marked (est.)", () => {
    render(
      <OrderTicketClosePanel
        slabAddress="Slab111" positionSize={1_777_000_000n} entryPriceE6={1_000_000n} capital={500_000_000n}
        symbol="TEST" collateralSymbol="USDC" decimals={6} tradingFeeBps={30n} maxFillAbs={null}
        lpUnderfunded={false} engineStale={false} oracleBlocked={false} onClosed={vi.fn()}
      />,
    );
    expect(screen.getByText("Trading Fee (est.):")).toBeTruthy();
    expect(screen.getByText(/12\.616/)).toBeTruthy();
    expect(est.calls.at(-1)).toEqual([1_777_000_000n, 30n, 1_000_000n]);
  });
});
