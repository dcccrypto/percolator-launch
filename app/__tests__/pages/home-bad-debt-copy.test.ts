/**
 * The home page said bad debt hits the insurance fund "never the wrapper, never other traders".
 * Losses past a market's own backing do reach other users: winning traders' profits are
 * haircut per side when the losing side's backing falls short (lib/market-health.ts payout
 * haircut), and on P3 markets Earn depositors take losses past the creator stake.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("home page loss-order claim", () => {
  const src = readFileSync(resolve(process.cwd(), "app/page.tsx"), "utf8");

  it("does not promise that losses never reach other traders", () => {
    expect(src).not.toMatch(/never other traders/i);
  });

  it("says the market's backing pays first and that winners can be paid in part", () => {
    expect(src).toContain("come out of that market's own backing first");
    expect(src).toContain("If the losing side's backing falls short, winning traders may be paid only part of their profit.");
  });

  // A winner's profit is backed by the LOSING side (engine 35ddd692 v16.rs:13728-13733 source_side =
  // opposite_side when net > 0; bankruptcy residual hits the opposite side, v16.rs:17372). Profit taken
  // during a haircut burns the unpaid part for good (v16.rs:1771-1785), so no "until it recovers".
  it("blames the losing side's backing and does not promise the unpaid part comes back", () => {
    expect(src).not.toMatch(/winning traders on that side/i);
    expect(src).not.toMatch(/until it recovers/i);
  });
});
