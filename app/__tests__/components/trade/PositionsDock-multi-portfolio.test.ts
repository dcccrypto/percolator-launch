/**
 * #2560 isolated margin: the dock renders one row per portfolio when a wallet
 * holds 2+ on a market, and the single-portfolio path stays untouched.
 *
 * Source-binding (same rationale as PositionsDock-sticky-actions.test): rendering
 * the dock needs the whole trade-page provider/hook stack. Instead we bind the
 * wiring that makes the feature safe:
 *  - the single vs multi choice is by portfolio COUNT, single still uses PositionRow;
 *  - every row's numbers come from the shared pure helper (no drift);
 *  - a per-row Close targets THAT portfolio's pubkey (not the lowest-pubkey pick);
 *  - the per-portfolio entry read is scoped (portfolio pubkey + isPrimary).
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/PositionsDock.tsx"),
  "utf8",
);

describe("PositionsDock multi-portfolio rendering", () => {
  it("chooses single-row vs multi-row by portfolio count; single still uses PositionRow", () => {
    expect(SRC).toContain("useOwnerMarketPortfolios");
    expect(SRC).toMatch(/infos\.length > 1/);
    // the <=1 branch returns the unchanged single-portfolio row
    expect(SRC).toMatch(/return <PositionRow slabAddress=\{slabAddress\} \/>;/);
  });

  it("derives every multi-row number from the shared pure helper (single source of truth)", () => {
    expect(SRC).toContain("computePositionRowView");
  });

  it("labels the lowest-pubkey portfolio Cross and the rest Isolated", () => {
    expect(SRC).toMatch(/isPrimary=\{i === 0\}/);
    expect(SRC).toMatch(/isPrimary \? "Cross" : "Isolated"/);
  });

  it("a per-row Close targets that portfolio's own pubkey", () => {
    expect(SRC).toMatch(/closePosition\(percent, portfolioPk\)/);
  });

  it("reads each portfolio's own entry (scoped by pubkey + isPrimary legacy-fallback control)", () => {
    expect(SRC).toMatch(/portfolio: portfolioPk\?\.toBase58\(\)/);
    expect(SRC).toMatch(/isPrimary,/);
  });
});
