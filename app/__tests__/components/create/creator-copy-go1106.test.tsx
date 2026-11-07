/**
 * Council 2026-11-06-go1106-ux, Creator seat (low + note), the create wizard's copy:
 *  1. "The wizard fee split says the 16% insurance share goes to stakers, who 'receive this share, moved into the stake
 *     pool automatically'. /stake opens with 'Fee-only stakers earn nothing while the market runs.'" (every v2.2 wizard
 *     launch gets a fee-only pool, so the wizard line was the false one).
 *  2. "The wizard header promises '≈ 0.14 SOL', but the pre-flight only lists 0.021 SOL of market rent, so a creator
 *     can't see where the other ~0.12 SOL goes."
 *  3. "Pasting the sim-USDC collateral mint says 'This token already has a market' and links to Percolator, PUMP and
 *     PENGU, which is the wrong reason."
 *  4. "BONK (a deep pool) can't launch at any leverage because of the price floor. The block message is clear, but it
 *     gives no next step."
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepControlRoom } from "@/components/create/StepControlRoom";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { isCollateralMint, COLLATERAL_MINT_REASON, priceFloorMessage } from "@/lib/creator-copy";

function renderControlRoom(over: Record<string, unknown> = {}) {
  const props = {
    symbol: "TEST",
    oracleLabel: "Keeper (Pump.fun)",
    startPrice: "$0.004869",
    slabBytes: 26508,
    rentSol: 0.021,
    totalSol: 0.1412,
    initialMarginBps: 1000,
    tradingFeeBps: 30,
    lpCollateral: "1000",
    insuranceAmount: "100",
    collateralSymbol: "USDC",
    seedTotal: 3100,
    seedBacking: 2000,
    onMarginBpsChange: vi.fn(),
    onLpCollateralChange: vi.fn(),
    onInsuranceChange: vi.fn(),
    onLaunch: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  return render(<StepControlRoom {...(props as never)} />);
}

describe("1. the wizard's fee split agrees with /stake on a v2.2 build", () => {
  it("v2.2 (fee-only pools): the insurance leg does not promise stakers the share", () => {
    __setDevnetV22ForTest(true);
    try {
      renderControlRoom();
      expect(document.body.textContent).not.toMatch(/Stakers provide this fund and receive this share/);
      expect(document.body.textContent).toMatch(/Backs losses a liquidation cannot cover\./);
    } finally {
      __setDevnetV22ForTest(null);
    }
  });
  it("flag off: the legacy line is unchanged (negative control)", () => {
    __setDevnetV22ForTest(false);
    try {
      renderControlRoom();
      expect(document.body.textContent).toMatch(/Stakers provide this fund and receive this share/);
    } finally {
      __setDevnetV22ForTest(null);
    }
  });
});

describe("2. the pre-flight shows the same total SOL as the header", () => {
  it("lists market rent AND the all-in total", () => {
    renderControlRoom();
    expect(screen.getByText("Market rent").nextSibling?.textContent).toBe("0.021 SOL");
    expect(screen.getByText("Total SOL (all accounts + fees)").nextSibling?.textContent).toBe("≈ 0.14 SOL");
  });
  it("no total known: a dash, never a made-up number", () => {
    renderControlRoom({ totalSol: null });
    expect(screen.getByText("Total SOL (all accounts + fees)").nextSibling?.textContent).toBe("—");
  });
});

describe("3. pasting the collateral mint names the real reason", () => {
  it("recognises the devnet collateral mint", () => {
    expect(isCollateralMint("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC")).toBe(true);
    expect(isCollateralMint(" DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC ")).toBe(true);
    expect(isCollateralMint("So11111111111111111111111111111111111111112")).toBe(false);
    expect(isCollateralMint("")).toBe(false);
  });
  it("says it is the collateral, not that it already has a market", () => {
    expect(COLLATERAL_MINT_REASON).toMatch(/collateral every market uses/i);
    expect(COLLATERAL_MINT_REASON).not.toMatch(/already has a market/i);
  });
});

describe("4. a token below the price floor at every leverage gets a next step", () => {
  it("below the floor even at the lowest leverage: says so and what to do", () => {
    const m = priceFloorMessage({ symbol: "BONK", price: "$0.00002", minPrice: "$0.000667", maxLeverage: 2, priceAboveLowestLeverageMin: false });
    expect(m).toContain("BONK trades at $0.00002, below the $0.000667 a 2x market needs to track its price");
    expect(m).toMatch(/can't be listed at any leverage yet/);
    expect(m).toMatch(/pick a token priced above/i);
  });
  it("a lower leverage would work: keeps the 'try lower leverage' hint (unchanged)", () => {
    const m = priceFloorMessage({ symbol: "X", price: "$0.001", minPrice: "$0.002", maxLeverage: 10, priceAboveLowestLeverageMin: true });
    expect(m).toBe("X trades at $0.001, below the $0.002 a 10x market needs to track its price — try lower leverage");
  });
});
