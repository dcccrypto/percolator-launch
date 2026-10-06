/**
 * OrderTicketClosePanel (GH#2651) — the money path of the ticket's Close mode.
 *
 * Now renders the FULL close form INLINE (shared ClosePositionForm), not a
 * button that opens a modal. The panel must (a) close ONLY through
 * useClosePosition (which re-reads the on-chain size, so a stale UI size can't
 * flip/increase the position), with the slider's chosen percent, (b) apply the
 * same block gates as PositionsDock, and (c) show PnL in COLLATERAL units.
 *
 * The real ClosePositionForm is rendered (pure presentation + lib math) so the
 * assertions exercise the actual inline UI.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act, within } from "@testing-library/react";

const closePosition = vi.fn();
const prewarmClose = vi.fn();
let hookState = { loading: false, error: null as string | null };
let live: { priceE6: bigint | null; priceUsd: number | null } = { priceE6: 110_000_000n, priceUsd: 110 };

// `freshPrewarmIdentity` models the REAL hook: prewarmClose is a useCallback
// whose deps include SlabProvider's programId, re-set on every slab update.
let freshPrewarmIdentity = false;
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({
    closePosition,
    prewarmClose: freshPrewarmIdentity ? () => prewarmClose() : prewarmClose,
    ...hookState,
  }),
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => live }));

import { OrderTicketClosePanel, type OrderTicketClosePanelProps } from "@/components/trade/OrderTicketClosePanel";
import { ClosePositionModal } from "@/components/trade/ClosePositionModal";

const base = (over: Partial<OrderTicketClosePanelProps> = {}): OrderTicketClosePanelProps => ({
  slabAddress: "Slab111",
  positionSize: 1_000_000n,
  entryPriceE6: 100_000_000n,
  capital: 50_000_000n,
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

beforeEach(() => {
  cleanup();
  closePosition.mockReset();
  closePosition.mockResolvedValue({ signature: "sig" });
  prewarmClose.mockReset();
  hookState = { loading: false, error: null };
  live = { priceE6: 110_000_000n, priceUsd: 110 };
  freshPrewarmIdentity = false;
});

const closeBtn = () => screen.getByRole("button", { name: /^close \d+%$/i }) as HTMLButtonElement;

describe("OrderTicketClosePanel (inline form)", () => {
  it("shows an empty state and no close button when there is no position", () => {
    render(<OrderTicketClosePanel {...base({ positionSize: 0n })} />);
    expect(screen.getByText("No open position")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^close \d+%$/i })).toBeNull();
  });

  it("GH#2707: while the account scan is pending, a 0n size renders loading, not 'No open position'", () => {
    render(<OrderTicketClosePanel {...base({ positionSize: 0n, accountPending: true })} />);
    expect(screen.getByTestId("close-panel-loading").textContent).toBe("Loading position…");
    expect(screen.queryByText("No open position")).toBeNull();
    expect(screen.queryByRole("button", { name: /^close \d+%$/i })).toBeNull();
  });

  it("GH#2707 CONTROL: a known position renders the close form even if accountPending were set", () => {
    render(<OrderTicketClosePanel {...base({ accountPending: true })} />);
    expect(screen.queryByTestId("close-panel-loading")).toBeNull();
    expect(closeBtn()).toBeTruthy();
  });

  it("prewarms the close on mount (no click needed)", () => {
    render(<OrderTicketClosePanel {...base()} />);
    expect(prewarmClose).toHaveBeenCalledTimes(1);
  });

  it("closes through useClosePosition at the default 100%, then reports it", async () => {
    const p = base();
    render(<OrderTicketClosePanel {...p} />);
    await act(async () => fireEvent.click(closeBtn()));
    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(closePosition).toHaveBeenCalledWith(100);
    expect(p.onClosed).toHaveBeenCalledWith(100);
  });

  it("respects a chosen preset percent", async () => {
    const p = base();
    render(<OrderTicketClosePanel {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    await act(async () => fireEvent.click(closeBtn()));
    expect(closePosition).toHaveBeenCalledWith(50);
    expect(p.onClosed).toHaveBeenCalledWith(50);
  });

  it("a failed close does not report success but surfaces the error", async () => {
    closePosition.mockRejectedValueOnce(new Error("boom"));
    hookState = { loading: false, error: "Could not verify current on-chain position." };
    const p = base();
    render(<OrderTicketClosePanel {...p} />);
    await act(async () => fireEvent.click(closeBtn()));
    expect(p.onClosed).not.toHaveBeenCalled();
    expect(screen.getByText("Could not verify current on-chain position.")).toBeTruthy();
  });

  it("renders a SHORT's side untouched (fresh size read happens in the hook)", () => {
    render(<OrderTicketClosePanel {...base({ positionSize: -2_000_000n })} />);
    expect(screen.getByText(/closing short position/i)).toBeTruthy();
  });

  it("disables + relabels the close button when the engine crank is behind", () => {
    render(<OrderTicketClosePanel {...base({ engineStale: true })} />);
    const btn = screen.getByRole("button", { name: /waiting for prices/i }) as HTMLButtonElement; // UX WP-2 calm label
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(closePosition).not.toHaveBeenCalled();
  });

  it("disables + relabels the close button when there is no valid mark", () => {
    live = { priceE6: null, priceUsd: null };
    render(<OrderTicketClosePanel {...base()} />);
    const btn = screen.getByRole("button", { name: /awaiting price/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(closePosition).not.toHaveBeenCalled();
  });

  it("disables the close when the LP is underfunded", () => {
    render(<OrderTicketClosePanel {...base({ lpUnderfunded: true })} />);
    expect(closeBtn().disabled).toBe(true);
    fireEvent.click(closeBtn());
    expect(closePosition).not.toHaveBeenCalled();
  });

  it("blocks the close (oracle-stale) when the oracle is blocked", () => {
    render(<OrderTicketClosePanel {...base({ oracleBlocked: true })} />);
    expect(closeBtn().disabled).toBe(true);
    expect(screen.getByText(/oracle stale/i)).toBeTruthy();
  });

  it("shows Est. PnL in collateral units (mark-to-market), not the raw native figure", () => {
    // 1 SOL long, entry $100, mark $110 -> exactly +$10 (one division, as the engine values it; the old
    // native-then-collateral path truncated it to +9.99999). Native coin-margined ~0.09.
    render(<OrderTicketClosePanel {...base()} />);
    expect(screen.getByText(/^\+10 USDC/)).toBeTruthy();
    expect(screen.queryByText(/\+0\.09/)).toBeNull();
  });

  it("shows a loss with a minus sign", () => {
    live = { priceE6: 90_000_000n, priceUsd: 90 };
    render(<OrderTicketClosePanel {...base()} />);
    expect(screen.getByText(/^-10 USDC/)).toBeTruthy();
  });
});

/* ── Review follow-up (#2662 on current playground): money-path invariants ── */

const rowValue = (container: HTMLElement, label: string): string => {
  const lbl = within(container).getByText(label);
  return (lbl.parentElement?.lastElementChild?.textContent ?? "").replace(/\s+/g, " ").trim();
};

describe("inline close — unknown entry (#2660/#2672 rules, 0n from OrderTicket)", () => {
  it("never shows the mark as the entry nor a confident PnL, and marks Balance After 'excl. PnL'", () => {
    const { container } = render(<OrderTicketClosePanel {...base({ entryPriceE6: 0n })} />);
    expect(screen.getByText("unknown entry")).toBeTruthy();
    expect(screen.queryByText(/\$110\.0+ entry|\$0\.0+ entry/)).toBeNull();
    expect(screen.getByTestId("close-pnl-unknown").textContent?.trim()).toBe("--");
    expect(rowValue(container, "Est. Account Balance After:")).toMatch(/excl\. PnL/);
  });

  it("…but closing stays ALLOWED: an unknown entry must never trap a position", async () => {
    const p = base({ entryPriceE6: 0n });
    render(<OrderTicketClosePanel {...p} />);
    expect(closeBtn().disabled).toBe(false);
    await act(async () => fireEvent.click(closeBtn()));
    expect(closePosition).toHaveBeenCalledWith(100);
  });
});

describe("inline close — where the funds go", () => {
  // A partial close leaves the whole capital in the account behind the remaining position; "Est.
  // Receive" counted capital × percent as paid out. A full close moves the funds back to the wallet
  // in a second approval (useClosePosition, #2831).
  // 1 SOL long, unknown entry (PnL 0), capital 50, fee 30 bps, 50% at $110: fee 0.165 → 49.835.
  it("a 50% close previews the whole capital minus the fee, not half the capital", () => {
    const { container } = render(<OrderTicketClosePanel {...base({ entryPriceE6: 0n })} />);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(rowValue(container, "Est. Account Balance After:")).toMatch(/^~49\.835 USDC/);
    expect(screen.queryByText("Est. Receive:")).toBeNull();
  });

  const FULL_COPY = "Your freed balance moves back to your wallet after one more approval.";
  const PARTIAL_COPY = "Closing keeps the funds in your trading account. Withdraw to move them to your wallet.";

  it("labels the row Est. Account Balance After at 50% and 100% (never a payout label)", () => {
    const { container } = render(<OrderTicketClosePanel {...base()} />);
    // 100%: capital 50 + PnL 10 (1 SOL, 100 → 110) − fee 0.33.
    expect(rowValue(container, "Est. Account Balance After:")).toMatch(/^~59\.67 USDC/);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(within(container).getByText("Est. Account Balance After:")).toBeTruthy();
    for (const old of ["Est. Receive:", "Est. Balance After:", "Est. Back to Wallet:"]) {
      expect(within(container).queryByText(old)).toBeNull();
    }
  });

  it("the funds-stay line depends on the percent: 50% stays, 100% goes back to the wallet", () => {
    render(<OrderTicketClosePanel {...base()} />);
    expect(screen.getByTestId("close-funds-stay").textContent).toBe(FULL_COPY);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(screen.getByTestId("close-funds-stay").textContent).toBe(PARTIAL_COPY);
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    expect(screen.getByTestId("close-funds-stay").textContent).toBe(FULL_COPY);
  });

  it("a full close in profit adds one calm line: profit is withdrawable once settled", () => {
    render(<OrderTicketClosePanel {...base()} />); // long 1 SOL, 100 → 110: +10 USDC
    expect(screen.getByTestId("close-profit-settles").textContent?.trim()).toBe(
      "Profit becomes withdrawable once it settles.",
    );
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(screen.queryByTestId("close-profit-settles")).toBeNull(); // partials never sweep
  });

  it("no profit line on a full close at a loss or with an unknown entry", () => {
    render(<OrderTicketClosePanel {...base({ entryPriceE6: 120_000_000n })} />);
    expect(screen.queryByTestId("close-profit-settles")).toBeNull();
    cleanup();
    render(<OrderTicketClosePanel {...base({ entryPriceE6: 0n })} />);
    expect(screen.queryByTestId("close-profit-settles")).toBeNull();
  });
});

describe("inline close — reduce-only by construction", () => {
  it("hands useClosePosition ONLY a whole percent in [1,100] (the hook re-reads the size)", async () => {
    render(<OrderTicketClosePanel {...base()} />);
    const slider = screen.getByRole("slider") as HTMLInputElement;
    for (const v of ["150", "-20", "0", "33.6", "100", "1"]) {
      fireEvent.change(slider, { target: { value: v } });
      await act(async () => fireEvent.click(closeBtn()));
    }
    for (const p of ["25%", "50%", "75%", "100%"]) {
      fireEvent.click(screen.getByRole("button", { name: p }));
      await act(async () => fireEvent.click(closeBtn()));
    }
    expect(closePosition.mock.calls.length).toBe(10);
    for (const call of closePosition.mock.calls) {
      expect(call).toHaveLength(1); // no size, no side — nothing that could flip/increase
      const pct = call[0] as number;
      expect(Number.isInteger(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(1);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it("the previewed close size never exceeds the position (100% → Remaining 0)", () => {
    const { container } = render(<OrderTicketClosePanel {...base({ positionSize: -2_000_000n })} />);
    expect(rowValue(container, "Close Size:")).toBe("2 SOL");
    expect(rowValue(container, "Remaining:")).toBe("0 SOL");
  });
});

describe("inline close — PnL / fee / balance after match ClosePositionModal exactly", () => {
  // 1 SOL long, entry $100, mark $110, capital 50 USDC, fee 30 bps, 50%:
  //   close notional 0.5 × 110 = 55 USDC → fee 0.165 USDC
  //   balance after = 50 (the whole capital stays) + PnL − 0.165
  const rows = ["Close Size:", "Remaining:", "Est. PnL:", "Trading Fee:", "Est. Account Balance After:"];

  it("inline numbers are the modal's numbers", () => {
    const p = base();
    const { container: inline } = render(<OrderTicketClosePanel {...p} />);
    fireEvent.click(within(inline).getByRole("button", { name: "50%" }));
    const inlineRows = rows.map((r) => rowValue(inline, r));
    cleanup();

    render(
      <ClosePositionModal
        positionSize={p.positionSize}
        entryPrice={p.entryPriceE6}
        currentPrice={110_000_000n}
        capital={p.capital}
        symbol={p.symbol}
        collateralSymbol={p.collateralSymbol}
        decimals={p.decimals}
        priceUsd={110}
        isLong
        loading={false}
        tradingFeeBps={p.tradingFeeBps}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "50%" }));
    expect(rows.map((r) => rowValue(dialog, r))).toEqual(inlineRows);
    expect(inlineRows[3]).toMatch(/^−0\.165 USDC$/);
    expect(inlineRows[4]).toMatch(/^~54\.8\d* USDC$/);
  });
});

describe("inline close — gates that flip while the form is open", () => {
  it.each([
    ["engineStale", { engineStale: true }],
    ["lpUnderfunded", { lpUnderfunded: true }],
    ["oracleBlocked", { oracleBlocked: true }],
  ] as const)("%s turning on after mount blocks the click", async (_n, over) => {
    const { rerender } = render(<OrderTicketClosePanel {...base()} />);
    rerender(<OrderTicketClosePanel {...base(over)} />);
    const btn = screen.getAllByRole("button").find((b) => /close \d+%|waiting for prices/i.test(b.textContent ?? ""))!;
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(btn));
    expect(closePosition).not.toHaveBeenCalled();
  });

  it("a close in flight disables the button (no double-submit)", () => {
    hookState = { loading: true, error: null };
    render(<OrderTicketClosePanel {...base()} />);
    const btn = screen.getByRole("button", { name: /closing/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("inline close — prewarm cost", () => {
  it("does NOT re-prewarm on every slab update (prewarmClose identity churn)", () => {
    freshPrewarmIdentity = true;
    const p = base();
    const { rerender } = render(<OrderTicketClosePanel {...p} />);
    for (let i = 0; i < 5; i++) rerender(<OrderTicketClosePanel {...p} capital={p.capital + BigInt(i)} />);
    expect(prewarmClose).toHaveBeenCalledTimes(1);
  });

  it("re-warms on hover/focus of the close button (the 4s fresh-read window)", () => {
    render(<OrderTicketClosePanel {...base()} />);
    prewarmClose.mockClear();
    fireEvent.pointerEnter(closeBtn());
    fireEvent.focus(closeBtn());
    expect(prewarmClose).toHaveBeenCalledTimes(2);
  });
});
