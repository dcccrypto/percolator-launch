/**
 * AUD-FC-A2 follow-up: on a RESOLVED market the ticket's Close mode must not build a normal trade (the program answers 21, then 14).
 * It shows the settled line and points at the trader resolved exit ("Close and withdraw", StaleSettleNotice); a Live market keeps
 * the normal inline close form. Real market bytes (CHILLHOUSE-T), mode byte flipped to Resolved.
 */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const closePosition = vi.fn();
const h = vi.hoisted(() => ({ raw: null as Uint8Array | null }));
vi.mock("@/hooks/useClosePosition", () => ({ useClosePosition: () => ({ closePosition, prewarmClose: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 110_000_000n, priceUsd: 110 }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ raw: h.raw, config: null, wrapperConfigV17: null }) }));

import { OrderTicketClosePanel } from "@/components/trade/OrderTicketClosePanel";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STALE_SETTLE_COPY } from "@/lib/v22/stale-resolve";
import { resolveMarketGeometry } from "@/lib/v22/sdk/layout";

const live = (): Uint8Array =>
  new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-growth/chillhouse-t.market.json"), "utf8")) as { data: string }).data, "base64"));
const resolved = (): Uint8Array => {
  const m = live();
  const g = resolveMarketGeometry(m, { parser: "t", strictLength: false });
  m[g.groupOff + g.layout.group.mode] = 1;
  return m;
};
const props = {
  slabAddress: "Slab111", positionSize: 1_000_000n, entryPriceE6: 100_000_000n, capital: 50_000_000n, symbol: "SOL", collateralSymbol: "USDC",
  decimals: 6, tradingFeeBps: 30n, maxFillAbs: null, lpUnderfunded: false, engineStale: false, oracleBlocked: false, onClosed: vi.fn(),
};

beforeEach(() => {
  closePosition.mockReset();
  __setDevnetV22ForTest(true);
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

describe("OrderTicketClosePanel on a Resolved market", () => {
  it("shows the settled line and offers no close form or confirm button; closePosition is never reachable", () => {
    h.raw = resolved();
    render(<OrderTicketClosePanel {...props} />);
    expect(screen.getByTestId("close-panel-settled")).toHaveTextContent(STALE_SETTLE_COPY.settledLine);
    expect(screen.getByTestId("close-panel-settled")).toHaveTextContent("Close and withdraw");
    expect(screen.queryByTestId("close-confirm")).toBeNull();
    expect(screen.queryByTestId("close-percent-chip")).toBeNull();
    expect(closePosition).not.toHaveBeenCalled();
  });

  it("negative control: the same position on a LIVE market keeps the normal close form", () => {
    h.raw = live();
    render(<OrderTicketClosePanel {...props} />);
    expect(screen.queryByTestId("close-panel-settled")).toBeNull();
    expect(screen.getByTestId("close-confirm")).toBeInTheDocument();
  });

  it("flag off: the panel is unchanged even on resolved bytes", () => {
    __setDevnetV22ForTest(false);
    h.raw = resolved();
    render(<OrderTicketClosePanel {...props} />);
    expect(screen.queryByTestId("close-panel-settled")).toBeNull();
  });

  it("no position still reads 'No open position' (the settled block is for a held position)", () => {
    h.raw = resolved();
    render(<OrderTicketClosePanel {...props} positionSize={0n} />);
    expect(screen.queryByTestId("close-panel-settled")).toBeNull();
    expect(screen.getByText("No open position")).toBeInTheDocument();
  });
});
