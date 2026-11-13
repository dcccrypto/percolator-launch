/**
 * Council r9 Risk MED: the close dialog's "Est. result if closed now" must include the growth busy-side fee paid when the position was
 * opened (it is not in the Entry since #3810). Real example: devnet fill Akgx5xp4... busy fee 2,989,999 atoms on 7.839061 SOL.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import type { SpreadEstimate } from "@/lib/v22/spread-estimate";
import { applyFill } from "@/lib/trade-book";
// Round 10: these pin the fee PARTS (what is added once, never twice); the display margin has its own tests (spread-size-aware).
vi.stubEnv("NEXT_PUBLIC_FEE_CAP_MARGIN_BPS", "0");

const SIZE = 7_839_061n; // 7.839061 units, 6 decimals
const ENTRY = 83_166_841n; // the price paid (booked + the spread)
const RISK = 82_918_087n; // the booked price
const MARK = 83_900_000n;
const BUSY = 2_989_999n;
const props = {
  positionSize: SIZE,
  entryPrice: ENTRY,
  riskEntryPrice: RISK,
  currentPrice: MARK,
  capital: 1_000_000_000n,
  symbol: "SOL",
  collateralSymbol: "USDC",
  decimals: 6,
  priceUsd: 83.9,
  isLong: true,
  loading: false,
  tradingFeeBps: 30n,
  closeFeeBpsFor: () => 52n,
  spreadEstimateFor: (): SpreadEstimate => ({ kind: "quote", bps: 22, execPriceE6: null, inFee: true }),
  onConfirm: () => {},
};
const num = (el: HTMLElement) => Number((el.textContent ?? "").replace(/[^0-9.+-]/g, "").replace(/^([+-]?)/, "$1")) ;

/** The realised result by the trade book's own rule: booked PnL minus EVERY fee_atoms (open: base + spread + busy; close). */
function realised(): bigint {
  const notionalOpen = (SIZE * RISK) / 1_000_000n;
  const spreadFee = (SIZE * (ENTRY - RISK)) / 1_000_000n; // the spread part, charged through fee_atoms
  const openFee = (notionalOpen * 30n) / 10_000n + spreadFee + BUSY;
  const closeNotional = (SIZE * MARK) / 1_000_000n;
  const closeFee = (closeNotional * 52n) / 10_000n;
  const opened = applyFill(null, { q: SIZE, bookedPriceE6: RISK, feeAtoms: openFee, funding: { netPaid: 0n, legs: 1 } });
  return applyFill(opened.book, { q: -SIZE, bookedPriceE6: MARK, feeAtoms: closeFee, funding: { netPaid: 0n, legs: 0 } }).closedResult as bigint;
}

describe("close dialog: the busy-side fee paid at open is in the net result", () => {
  it("the Risk repro: a busy-opened position is NOT green, shows the busy-side row, and equals the realised result within rounding", () => {
    render(<ClosePositionForm {...props} busyOpenFeeAtoms={BUSY} busyFeeMayApply />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "negative");
    expect(net.className).not.toContain("--long");
    expect(screen.getByTestId("close-busy-open-fee").textContent).toContain("Busy-side fee (paid when you opened)");
    expect(screen.getByTestId("close-busy-open-fee").textContent).toContain("2.989999");
    const shown = Math.round(num(net) * 1e6); // atoms (net is "-x.xxxxxx USDC")
    const real = Number(realised());
    expect(real).toBeLessThan(0);
    expect(Math.abs(shown - real)).toBeLessThanOrEqual(5);
    expect(screen.queryByTestId("close-net-excl-busy")).toBeNull();
  });
  it("without the fix's term the same position would read green (the old headline): the busy-side amount is what turns it", () => {
    render(<ClosePositionForm {...props} busyOpenFeeAtoms={0n} busyFeeMayApply />);
    expect(screen.getByTestId("close-net-result")).toHaveAttribute("data-sign", "positive");
    expect(screen.queryByTestId("close-busy-open-fee")).toBeNull();
  });
  it("a 50% close takes half of the busy-side fee", () => {
    render(<ClosePositionForm {...props} busyOpenFeeAtoms={BUSY} busyFeeMayApply />);
    fireEvent.click(screen.getAllByTestId("close-percent-chip").find((b) => b.getAttribute("data-percent") === "50")!);
    expect(screen.getByTestId("close-busy-open-fee").textContent).toContain("1.494999");
  });
  it("amount unknown on a market that can charge one: a positive net is NEUTRAL with the 'excl. busy-side fee' tag, never green", () => {
    render(<ClosePositionForm {...props} busyOpenFeeAtoms={null} busyFeeMayApply />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "positive");
    expect(net.className).not.toContain("--long");
    expect(net.className).toContain("--text-muted");
    expect(screen.getByTestId("close-net-excl-busy").textContent).toBe("excl. busy-side fee");
    expect(screen.queryByTestId("close-busy-open-fee")).toBeNull();
  });
  it("amount unknown and the net is a loss: still red (a loss stays a loss)", () => {
    render(<ClosePositionForm {...props} currentPrice={82_000_000n} busyOpenFeeAtoms={null} busyFeeMayApply />);
    expect(screen.getByTestId("close-net-result").className).toContain("--short");
  });
  it("a record without the field on a market that cannot charge one behaves as today: green, no tag, no row", () => {
    render(<ClosePositionForm {...props} />);
    const net = screen.getByTestId("close-net-result");
    expect(net.className).toContain("--long");
    expect(screen.queryByTestId("close-net-excl-busy")).toBeNull();
    expect(screen.queryByTestId("close-busy-open-fee")).toBeNull();
  });
});

describe("r10 owner decision 1: the close dialog's estimate includes the funding paid so far", () => {
  const base = { ...props, busyOpenFeeAtoms: BUSY, busyFeeMayApply: true };
  const netAtoms = () => Math.round(num(screen.getByTestId("close-net-result")) * 1e6);
  it("funding paid is subtracted from the net, shown on its own row, and the estimate equals the realised result by the trade book (same funding)", () => {
    const { unmount } = render(<ClosePositionForm {...base} fundingPaidAtoms={0n} />);
    const without = netAtoms();
    unmount();
    render(<ClosePositionForm {...base} fundingPaidAtoms={51_132n} />);
    expect(netAtoms()).toBe(without - 51_132);
    expect(screen.getByTestId("close-funding").textContent).toContain("Funding paid so far");
    expect(screen.getByTestId("close-funding").textContent).toContain("0.051132");
    expect(screen.queryByTestId("close-net-excl-funding")).toBeNull();
    // realised by the book: same fills, funding counters 0 -> 51,132 over the hold
    const notionalOpen = (SIZE * RISK) / 1_000_000n;
    const openFee = (notionalOpen * 30n) / 10_000n + (SIZE * (ENTRY - RISK)) / 1_000_000n + BUSY;
    const closeFee = (((SIZE * MARK) / 1_000_000n) * 52n) / 10_000n;
    const o = applyFill(null, { q: SIZE, bookedPriceE6: RISK, feeAtoms: openFee, funding: { netPaid: 0n, legs: 1 } });
    const real = applyFill(o.book, { q: -SIZE, bookedPriceE6: MARK, feeAtoms: closeFee, funding: { netPaid: 51_132n, legs: 0 } }).closedResult as bigint;
    expect(Math.abs(netAtoms() - Number(real))).toBeLessThanOrEqual(5);
  });
  it("funding RECEIVED adds to the net and is labelled received", () => {
    render(<ClosePositionForm {...base} fundingPaidAtoms={-3_007n} />);
    expect(screen.getByTestId("close-funding").textContent).toContain("Funding received so far");
  });
  it("a partial close takes its share of the funding", () => {
    const { unmount } = render(<ClosePositionForm {...base} fundingPaidAtoms={0n} />);
    fireEvent.click(screen.getAllByTestId("close-percent-chip").find((c) => c.getAttribute("data-percent") === "50") as HTMLElement);
    const w0 = netAtoms();
    unmount();
    render(<ClosePositionForm {...base} fundingPaidAtoms={10_000n} />);
    fireEvent.click(screen.getAllByTestId("close-percent-chip").find((c) => c.getAttribute("data-percent") === "50") as HTMLElement);
    expect(Math.abs(netAtoms() - (w0 - 5_000))).toBeLessThanOrEqual(1);
  });
  it("NEGATIVE: unknown funding keeps the net but tags it 'excl. funding' and never green", () => {
    // a mark far above the entry so the net would be a clear profit
    render(<ClosePositionForm {...base} busyOpenFeeAtoms={0n} currentPrice={95_000_000n} fundingPaidAtoms={null} />);
    expect(screen.getByTestId("close-net-excl-funding")).toBeInTheDocument();
    expect(screen.getByTestId("close-net-result").className).not.toContain("--long");
  });
  it("the old 'funding not included' wording is gone", () => {
    render(<ClosePositionForm {...base} fundingPaidAtoms={0n} />);
    expect(document.body.textContent).not.toMatch(/funding.{0,30}not included/i);
  });
});
