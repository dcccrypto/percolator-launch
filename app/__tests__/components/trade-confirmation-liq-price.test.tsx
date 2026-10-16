/**
 * #2634: the confirm modal's "Est. Liquidation Price" rendered a bare "N/A"
 * when the resulting position is covered by collateral (no liquidation price).
 * With the display from OrderTicket it shows the margin-health figure instead.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useLockBodyScroll", () => ({ useLockBodyScroll: () => {} }));
vi.mock("gsap", () => ({
  default: { set: () => {}, to: () => {}, fromTo: () => {}, killTweensOf: () => {} },
}));

import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { describeLiqPrice } from "@/lib/liq-price-display";

type Props = Parameters<typeof TradeConfirmationModal>[0];
const props = (over: Partial<Props> = {}): Props => ({
  direction: "long",
  positionSize: 1_000_000n,
  margin: 100_000_000n,
  leverage: 2,
  estimatedLiqPrice: 0n,
  tradingFee: 50_000n,
  worstFillPriceE6: 1_010_000n,
  accountEquity: 500_000_000n,
  symbol: "SOL",
  collateralSymbol: "USDC",
  decimals: 6,
  onConfirm: () => {},
  onCancel: () => {},
  ...over,
});

describe("TradeConfirmationModal liquidation price", () => {
  it("shows margin health when there is no liquidation price", () => {
    const estimatedLiqDisplay = describeLiqPrice({
      liqPriceE6: 0n,
      positionSize: 1_000_000n,
      capital: 300_000_000n,
      markPriceE6: 100_000_000n,
      maintenanceMarginBps: 500n,
      hasResolvedEntry: true,
    });
    render(<TradeConfirmationModal {...props({ estimatedLiqDisplay })} />);
    expect(screen.getByText("300% mgn")).toBeInTheDocument();
    expect(screen.queryByText("N/A")).toBeNull();
  });

  // #58: neutral like the dock/panel for a new (always "safe") position, never red or green by side.
  it.each(["long", "short"] as const)("shows the price in the neutral colour for a %s", (direction) => {
    render(<TradeConfirmationModal {...props({ direction, estimatedLiqPrice: 950_000n })} />);
    const cls = screen.getByText("$0.95").className;
    expect(cls).toContain("var(--text-secondary)");
    expect(cls).not.toMatch(/var\(--(short|long)\)/);
  });

  it("keeps the price for a caller that only has the raw price", () => {
    render(<TradeConfirmationModal {...props({ estimatedLiqPrice: 950_000n })} />);
    expect(screen.getByText("$0.95")).toBeInTheDocument();
  });
});
