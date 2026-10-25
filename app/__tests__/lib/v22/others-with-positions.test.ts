/**
 * othersWithPositions: who blocks the admin "Settle and withdraw everything" path (decision C). Pins each exclusion separately so
 * dropping one of them fails a test: the wallet's own rows, the Earn vault registry's row, and empty rows never count.
 */
import { describe, expect, it } from "vitest";
import { othersWithPositions, type MarketPortfolioRow } from "@/lib/v22/resolved-claims";

const WALLET = "Wa11et1111111111111111111111111111111111111";
const REGISTRY = "Reg1stry11111111111111111111111111111111111";
const TRADER = "Trader1111111111111111111111111111111111111";

describe("othersWithPositions", () => {
  it("the Earn vault registry's own portfolio is not another user", () => {
    const rows: MarketPortfolioRow[] = [{ owner: REGISTRY, empty: false }];
    expect(othersWithPositions(rows, WALLET, REGISTRY)).toBe(0);
  });

  it("an empty portfolio of another user does not block", () => {
    const rows: MarketPortfolioRow[] = [{ owner: TRADER, empty: true }];
    expect(othersWithPositions(rows, WALLET, REGISTRY)).toBe(0);
  });

  it("the wallet's own non-empty portfolio does not block", () => {
    const rows: MarketPortfolioRow[] = [{ owner: WALLET, empty: false }];
    expect(othersWithPositions(rows, WALLET, REGISTRY)).toBe(0);
  });

  it("another user's non-empty portfolio blocks, counted once per row", () => {
    const rows: MarketPortfolioRow[] = [
      { owner: WALLET, empty: false },
      { owner: REGISTRY, empty: false },
      { owner: TRADER, empty: true },
      { owner: TRADER, empty: false },
    ];
    expect(othersWithPositions(rows, WALLET, REGISTRY)).toBe(1);
  });
});
