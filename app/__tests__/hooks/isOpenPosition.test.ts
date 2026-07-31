import { describe, it, expect } from "vitest";
import { isOpenPosition, type PortfolioPosition } from "@/hooks/usePortfolio";

// isOpenPosition only reads `pos.account?.positionSize`, so a minimal shape is
// enough to lock the open/closed boundary that the dashboard counts depend on.
const pos = (positionSize: bigint | undefined, capital = 0n): PortfolioPosition =>
  ({ account: positionSize === undefined ? undefined : { positionSize, capital } } as unknown as PortfolioPosition);

describe("isOpenPosition", () => {
  it("is true for an open long (positive size)", () => {
    expect(isOpenPosition(pos(5_000n))).toBe(true);
  });

  it("is true for an open short (negative size)", () => {
    expect(isOpenPosition(pos(-5_000n))).toBe(true);
  });

  it("is FALSE for a closed/flat position (size 0) — the reported bug", () => {
    // A position the user closed still has a portfolio account with size 0;
    // it must NOT count as open.
    expect(isOpenPosition(pos(0n))).toBe(false);
  });

  it("is FALSE for a funded-but-flat account (idle deposit: size 0, capital > 0)", () => {
    // Idle capital in a closed market is not an open position — it belongs in
    // the idle-deposits surface, not the open-positions count.
    expect(isOpenPosition(pos(0n, 1_000_000n))).toBe(false);
  });

  it("is FALSE when the account is missing entirely", () => {
    expect(isOpenPosition(pos(undefined))).toBe(false);
  });

  it("filters a mixed book down to only the open positions", () => {
    const book = [pos(5_000n), pos(0n, 1_000_000n), pos(-3_000n), pos(0n)];
    expect(book.filter(isOpenPosition)).toHaveLength(2);
  });
});
