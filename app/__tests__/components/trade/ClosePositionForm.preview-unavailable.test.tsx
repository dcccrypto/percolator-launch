import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";

const props = {
  variant: "modal" as const,
  positionSize: 80_000_000n,
  entryPrice: 99_875_000n,
  currentPrice: 100_000_000n,
  capital: 1_000_000_000n,
  symbol: "TEST",
  decimals: 6,
  priceUsd: 100,
  isLong: true,
  loading: false,
  onConfirm: () => {},
  onCancel: () => {},
};

describe("ClosePositionForm withholds the raw-size preview when the ADL state is unknown (#3077 item 3)", () => {
  it("previewUnavailable: no size, PnL or balance preview; the close controls remain", () => {
    const { container } = render(<ClosePositionForm {...props} previewUnavailable />);
    expect(screen.getByTestId("close-preview-unavailable")).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).not.toContain("Est. PnL");
    expect(text).not.toContain("Est. Account Balance After");
    expect(text).not.toContain("Close Size");
    // the raw 80 is never printed as the size
    expect(text).not.toMatch(/\b80(\.0+)?\s*TEST/);
    expect(screen.getByTestId("close-percent-input")).toBeInTheDocument();
  });

  it("NEGATIVE CONTROL: with the preview available the same form shows size, PnL and balance", () => {
    const { container } = render(<ClosePositionForm {...props} />);
    expect(screen.queryByTestId("close-preview-unavailable")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("Est. PnL");
    expect(text).toContain("Est. Account Balance After");
    expect(text).toContain("Close Size");
  });
});
