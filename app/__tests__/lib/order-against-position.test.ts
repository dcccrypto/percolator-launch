/**
 * orderAgainstPosition: an Open-tab order on the other side of the open position releases
 * margin instead of reserving it. The program checks initial margin only when |next| >= |current|.
 * Long 10 (q 10e6) with 1 USDC locked, 2 USDC capital, orders at 1x (margin = size in USDC atoms).
 */
import { describe, expect, it } from "vitest";
import { orderAgainstPosition } from "@/lib/trading";

const LOCKED = 1_000_000n;
const CAPITAL = 2_000_000n;
const short = (size: bigint, capital = CAPITAL) => orderAgainstPosition(size, size, "short", 10_000_000n, LOCKED, capital);

describe("orderAgainstPosition", () => {
  it("is null for a flat account, a same-side order or an empty order", () => {
    expect(orderAgainstPosition(5n, 5n, "long", 0n, 0n, CAPITAL)).toBeNull();
    expect(orderAgainstPosition(5n, 5n, "long", 10_000_000n, LOCKED, CAPITAL)).toBeNull();
    expect(orderAgainstPosition(5n, 5n, "short", -10_000_000n, LOCKED, CAPITAL)).toBeNull();
    expect(short(0n)).toBeNull();
  });

  it("a reduce frees its share of the locked margin and never falls short", () => {
    expect(short(5_000_000n)).toEqual({ shortBy: 0n, afterAvailable: 1_500_000n });
  });

  it("a close frees all of it", () => {
    expect(short(10_000_000n)).toEqual({ shortBy: 0n, afterAvailable: 2_000_000n });
  });

  it("a flip that ends smaller is not checked (|next| < |current|)", () => {
    expect(short(15_000_000n)?.shortBy).toBe(0n);
  });

  it("a flip that ends as large or larger is checked against capital", () => {
    // 10 past the long at 1x = 10 USDC against 2 USDC of capital
    expect(short(20_000_000n)).toEqual({ shortBy: 8_000_000n, afterAvailable: 0n });
  });

  it("an account under its locked margin still frees margin on a reduce", () => {
    expect(short(5_000_000n, 500_000n)).toEqual({ shortBy: 0n, afterAvailable: 0n });
    expect(short(10_000_000n, 500_000n)).toEqual({ shortBy: 0n, afterAvailable: 500_000n });
  });

  it("mirrors for a short position", () => {
    expect(orderAgainstPosition(5_000_000n, 5_000_000n, "long", -10_000_000n, LOCKED, CAPITAL)).toEqual({
      shortBy: 0n,
      afterAvailable: 1_500_000n,
    });
  });
});
