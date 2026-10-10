/**
 * The order ticket's Close tab said "No open position — You have no open
 * position in this market to close" for a position the wallet holds through a
 * Position NFT, while the dock, /portfolio and the header bar all listed it.
 *
 * Wrapping moves the portfolio's owner to the NFT escrow, so useUserAccount
 * (owner == wallet) never sees it and OrderTicket hands the panel 0n. The
 * panel now runs the same wrapped-position lookup as PositionsDock and, when
 * one exists on this market, says the position is wrapped and how to unwrap it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), prewarmClose: vi.fn(), loading: false, error: null }),
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 110_000_000n, priceUsd: 110 }) }));

// What the wrapped-position lookup returns, and every `enabled` it was called with.
let wrappedSize: bigint | null = null;
const lookupCalls: Array<{ slab: string; enabled: boolean }> = [];
vi.mock("@/hooks/useNftWrappedPosition", () => ({
  useNftWrappedPosition: (slab: string, enabled: boolean) => {
    lookupCalls.push({ slab, enabled });
    if (!enabled || wrappedSize === null) return null;
    return { idx: 0, account: { positionSize: wrappedSize, capital: 30_444_854n }, nftMint: {}, nftPda: {} };
  },
}));

import { OrderTicketClosePanel, type OrderTicketClosePanelProps } from "@/components/trade/OrderTicketClosePanel";

const base = (over: Partial<OrderTicketClosePanelProps> = {}): OrderTicketClosePanelProps => ({
  slabAddress: "9efj3hdgb2qQvkHKYP9DjZYJQZqC1XiY5XgCiZkvss7u",
  positionSize: 0n,
  entryPriceE6: 100_000_000n,
  capital: 0n,
  symbol: "SOL",
  collateralSymbol: "USDC",
  decimals: 6,
  tradingFeeBps: 30n,
  maxFillAbs: null,
  lpUnderfunded: false,
  engineStale: false,
  oracleBlocked: false,
  onClosed: vi.fn(),
  ...over,
});

const closeBtn = () => screen.queryByRole("button", { name: /^close \d+%$/i });

beforeEach(() => {
  cleanup();
  wrappedSize = null;
  lookupCalls.length = 0;
});

describe("OrderTicketClosePanel: position wrapped as a Position NFT", () => {
  it("a wrapped short on this market is named as wrapped, never 'No open position'", () => {
    wrappedSize = -163_908n;
    render(<OrderTicketClosePanel {...base()} />);
    const panel = screen.getByTestId("close-panel-wrapped");
    expect(panel.textContent).toContain("Position wrapped as an NFT");
    expect(panel.textContent).toContain("Your short on this market is held in a Position NFT");
    expect(panel.textContent).toContain("Unwrap it from the ⋯ menu");
    expect(screen.queryByText("No open position")).toBeNull();
    // The ticket cannot close an escrowed portfolio: no close form.
    expect(closeBtn()).toBeNull();
  });

  it("a wrapped long says long", () => {
    wrappedSize = 82_910n;
    render(<OrderTicketClosePanel {...base()} />);
    expect(screen.getByTestId("close-panel-wrapped").textContent).toContain("Your long on this market");
  });

  it("CONTROL: with no wrapped position it is still 'No open position'", () => {
    render(<OrderTicketClosePanel {...base()} />);
    expect(screen.getByText("No open position")).toBeTruthy();
    expect(screen.queryByTestId("close-panel-wrapped")).toBeNull();
  });

  it("CONTROL: a wrapped NFT whose leg is closed (size 0) is not shown as a position", () => {
    wrappedSize = 0n;
    render(<OrderTicketClosePanel {...base()} />);
    expect(screen.getByText("No open position")).toBeTruthy();
    expect(screen.queryByTestId("close-panel-wrapped")).toBeNull();
  });

  it("looks up THIS market, and only when the wallet has no directly-owned position", () => {
    render(<OrderTicketClosePanel {...base()} />);
    expect(lookupCalls.at(-1)).toEqual({ slab: "9efj3hdgb2qQvkHKYP9DjZYJQZqC1XiY5XgCiZkvss7u", enabled: true });

    cleanup();
    lookupCalls.length = 0;
    wrappedSize = -163_908n;
    render(<OrderTicketClosePanel {...base({ positionSize: -1_000_000n, capital: 50_000_000n })} />);
    expect(lookupCalls.every((c) => c.enabled === false)).toBe(true);
    // A directly-owned position keeps the normal close form.
    expect(screen.queryByTestId("close-panel-wrapped")).toBeNull();
    expect(closeBtn()).toBeTruthy();
  });

  it("does not look up while the account scan is pending (still 'Loading position…')", () => {
    wrappedSize = -163_908n;
    render(<OrderTicketClosePanel {...base({ accountPending: true })} />);
    expect(lookupCalls.every((c) => c.enabled === false)).toBe(true);
    expect(screen.getByTestId("close-panel-loading")).toBeTruthy();
  });
});
