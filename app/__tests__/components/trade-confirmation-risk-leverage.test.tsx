/**
 * Finding #3, modal side: Risk Lev. takes the after-trade figure the ticket passes (null hides
 * the row), and the wallet deposit bundled with the trade gets its own row. With neither prop,
 * the modal keeps its old order-over-capital figure.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useLockBodyScroll", () => ({ useLockBodyScroll: () => {} }));
vi.mock("gsap", () => ({ default: { set: () => {}, to: () => {}, fromTo: () => {}, killTweensOf: () => {} } }));

import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { computeRiskLeverage } from "@/lib/leverage-display";

type Props = Parameters<typeof TradeConfirmationModal>[0];
const props = (over: Record<string, unknown> = {}) => ({
  direction: "long", positionSize: 1_000_000n, margin: 100_000_000n, leverage: 2,
  estimatedLiqPrice: 0n, tradingFee: 0n, worstFillPriceE6: 0n, accountEquity: 10_000_000n,
  symbol: "SOL", collateralSymbol: "USDC", decimals: 6, onConfirm: () => {}, onCancel: () => {}, ...over,
}) as unknown as Props;

const riskRow = () => screen.getByText(/Risk Lev\./).parentElement!.parentElement!;

describe("modal: Risk Lev. and the bundled deposit", () => {
  it("shows the passed after-trade risk leverage instead of order / old capital", () => {
    render(<TradeConfirmationModal {...props({ riskLeverage: 1.82 })} />);
    expect(riskRow().textContent).toContain("1.82x"); // the old formula reads 200 / 10 = 20x
  });

  it("null hides the row (nothing left open)", () => {
    render(<TradeConfirmationModal {...props({ riskLeverage: null })} />);
    expect(screen.queryByText(/Risk Lev\./)).toBeNull();
  });

  it("shows the wallet deposit that rides with the trade", () => {
    render(<TradeConfirmationModal {...props({ depositAmount: 540_000_000n })} />);
    expect(screen.getByText("Deposit from Wallet:").nextElementSibling!.textContent).toBe("540 USDC");
  });

  it("CONTROL: no new props: the old row, no deposit row", () => {
    render(<TradeConfirmationModal {...props()} />);
    expect(riskRow().textContent).toContain("20x");
    expect(screen.queryByText(/Deposit from Wallet/)).toBeNull();
  });
});

describe("computeRiskLeverage", () => {
  it("resulting position over collateral; null when flat / no price / no collateral", () => {
    expect(computeRiskLeverage(305_000_000n, 1_000_000n, 100_000_000n)).toBe(3.05);
    expect(computeRiskLeverage(99_999_999n, 1_000_000n, 50_000_000n)).toBe(2); // 1.99999998 -> 2, not "2.0"
    expect(computeRiskLeverage(400_000n, 1_000_000n, 100_000_000n)).toBe(0.01); // 0.004 -> 0.01, never "0x"
    expect(computeRiskLeverage(-295_000_000n, 1_000_000n, 100_000_000n)).toBe(2.95);
    expect(computeRiskLeverage(0n, 1_000_000n, 100_000_000n)).toBeNull();
    expect(computeRiskLeverage(1n, 0n, 100_000_000n)).toBeNull();
    expect(computeRiskLeverage(1n, 1_000_000n, 0n)).toBeNull();
    expect(computeRiskLeverage(1n, 1_000_000n, -5n)).toBeNull();
    expect(() => computeRiskLeverage(2n ** 200n, 2n ** 60n, 1n)).not.toThrow();
  });
});
