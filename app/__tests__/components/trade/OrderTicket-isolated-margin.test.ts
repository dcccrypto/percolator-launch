/**
 * #2560 isolated margin: the Cross/Isolated toggle (above Long/Short) and its
 * open flow. Source-binding (OrderTicket needs its entire provider/hook stack to
 * render) — we bind the wiring that makes the money path correct:
 *  - Isolated always funds a brand-new portfolio (forceNewPortfolio) and the
 *    FULL margin, never netted against the primary;
 *  - the open is blocked rather than silently routed to a cross trade when it
 *    can't fund a new portfolio;
 *  - the entry is written SCOPED for isolated and LEGACY for cross (so the
 *    untouched single-row path still resolves the cross entry).
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/OrderTicket.tsx"),
  "utf8",
);

describe("OrderTicket isolated-margin toggle", () => {
  it("has a Cross/Isolated toggle, defaulting to cross", () => {
    expect(SRC).toMatch(/useState<"cross" \| "isolated">\("cross"\)/);
    expect(SRC).toContain('data-testid="margin-mode-cross"');
    expect(SRC).toContain('data-testid="margin-mode-isolated"');
  });

  it("isolated always funds a fresh portfolio from the wallet (first-trade-like)", () => {
    expect(SRC).toMatch(/const isolatedOpen = marginMode === "isolated"/);
    // isolated folds into fundingMode, and funds the FULL margin
    expect(SRC).toMatch(/needsAccount \|\| needsDeposit \|\| exceedsBalance \|\| isolatedOpen/);
    expect(SRC).toMatch(/const marginShort = \(needsAccount \|\| isolatedOpen\)/);
  });

  it("opens isolated in a NEW portfolio (forceNewPortfolio) and captures its pubkey", () => {
    expect(SRC).toMatch(/forceNewPortfolio: isolatedOpen/);
    expect(SRC).toMatch(/openedPortfolio = r\.portfolio/);
  });

  it("blocks the open instead of silently routing isolated to a cross trade", () => {
    expect(SRC).toMatch(/\(marginMode === "isolated" && !isolatedOpen\)/);
  });

  it("writes the entry SCOPED for isolated, LEGACY (undefined) for cross", () => {
    expect(SRC).toMatch(/saveEntryPrice\(slabAddress, entryIdx, livePriceE6, leverage, wallet, isolatedOpen \? openedPortfolio\?\.toBase58\(\) : undefined\)/);
    // isolated forces the "this fill IS the entry" (save) branch
    expect(SRC).toMatch(/existingPositionSize === 0n \|\| isolatedOpen/);
  });
});
