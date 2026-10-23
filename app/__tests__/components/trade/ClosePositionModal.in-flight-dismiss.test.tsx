/**
 * #59: while a close is in flight the modal stays open. Escape, a backdrop click and the header
 * close button used to call onCancel mid-close; on /portfolio that unmounted the flow and the
 * close's result (or its error) had nowhere to show. Cancel was already disabled while loading.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

import { ClosePositionModal } from "@/components/trade/ClosePositionModal";

const props = (loading: boolean, onCancel: () => void) => ({
  positionSize: 5_000_000n,
  entryPrice: 100_000_000n,
  currentPrice: 100_000_000n,
  capital: 1_000_000_000n,
  symbol: "SOL",
  collateralSymbol: "USDC",
  decimals: 6,
  priceUsd: 100,
  isLong: true,
  loading,
  onConfirm: vi.fn(),
  onCancel,
});

const overlay = () => screen.getByTestId("close-modal").parentElement as HTMLElement;

describe("ClosePositionModal dismissal", () => {
  it("mid-close: Escape, backdrop and the header close button do nothing", () => {
    const onCancel = vi.fn();
    render(<ClosePositionModal {...props(true, onCancel)} />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(overlay());
    const x = screen.getByRole("button", { name: "Close" });
    expect(x).toBeDisabled();
    fireEvent.click(x);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("CONTROL: idle, each one cancels", () => {
    const onCancel = vi.fn();
    render(<ClosePositionModal {...props(false, onCancel)} />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(overlay());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});
