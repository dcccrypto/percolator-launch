import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #2510 — `totalTrades: rows.length` reported the CAPPED row count with nothing
// marking it as a floor, so a wallet above the cap silently under-reported every
// aggregate (volume, fees, unique markets) with no signal to the caller.
describe("#2510 trader stats surface truncation", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../app/api/trader/[wallet]/stats/route.ts"),
    "utf8",
  );

  it("names the cap once instead of repeating a literal", () => {
    expect(src).toMatch(/export const TRADER_STATS_MAX_ROWS = 10_000;/);
    // the raw literal must not survive in the queries, or cap and flag can drift
    expect(src).not.toMatch(/\.limit\(10_000\)/);
  });

  it("applies the named cap to BOTH query paths (primary and fallback)", () => {
    const uses = src.match(/\.limit\(TRADER_STATS_MAX_ROWS\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("exposes a truncated flag derived from the cap", () => {
    expect(src).toMatch(/truncated:\s*rows\.length >= TRADER_STATS_MAX_ROWS/);
  });

  it("declares truncated on the response type", () => {
    expect(src).toMatch(/truncated:\s*boolean;/);
  });

  it("sets truncated:false on the empty-result path", () => {
    expect(src).toMatch(/totalTrades:\s*0,\s*\n\s*truncated:\s*false,/);
  });
});
