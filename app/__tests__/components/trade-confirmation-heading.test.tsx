/**
 * Confirm modal heading: an order against the open position reads Reducing / Closing /
 * "Closing X, Opening Y"; without the new prop it keeps "Opening ... Position".
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useLockBodyScroll", () => ({ useLockBodyScroll: () => {} }));

import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";

type Props = Parameters<typeof TradeConfirmationModal>[0];
const props = (over: Partial<Props> = {}): Props => ({
  direction: "short", positionSize: 1_000_000n, margin: 100_000_000n, leverage: 2,
  estimatedLiqPrice: 0n, tradingFee: 50_000n, symbol: "SOL", collateralSymbol: "USDC", decimals: 6,
  onConfirm: () => {}, onCancel: () => {}, ...over,
});

describe("confirm modal heading names what the order does to the open position", () => {
  it.each([
    [3_000_000n, "Reducing Long Position"],
    [1_000_000n, "Closing Long Position"],
    [400_000n, "Closing Long, Opening Short"],
  ])("short 1.0 against long %s", (existing, heading) => {
    render(<TradeConfirmationModal {...props({ existingPositionSize: existing })} />);
    expect(screen.getByText(heading)).toBeInTheDocument();
    expect(screen.queryByText("Opening Short Position")).toBeNull();
  });

  it("CONTROL: no open position (or prop omitted) keeps 'Opening'", () => {
    render(<TradeConfirmationModal {...props({ direction: "long" })} />);
    expect(screen.getByText("Opening Long Position")).toBeInTheDocument();
  });
});
