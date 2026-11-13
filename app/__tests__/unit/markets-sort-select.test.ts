// @vitest-environment node
/** UX WP-10 (audit §4.8): on phones the /markets sort is one "Sort" select; tabs only from md up. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(process.cwd(), "app/markets/page.tsx"), "utf8");

describe("/markets sort", () => {
  it("a select below md bound to the same sort state; the tab group is md+ only", () => {
    expect(src).toMatch(/<label className="md:hidden[^"]*">\s*<span>Sort<\/span>\s*<select\s+data-testid="markets-sort-select"/);
    expect(src).toContain("value={sortBy}");
    expect(src).toContain("onChange={(e) => setSortBy(e.target.value as SortKey)}");
    expect(src).toContain('className="relative hidden md:flex gap-1');
    // one option list for both, every sort key present (incl. the new max-leverage sort)
    const opts = src.slice(src.indexOf("const MARKET_SORT_OPTIONS"), src.indexOf("];", src.indexOf("const MARKET_SORT_OPTIONS")));
    for (const k of ["volume", "oi", "leverage", "health", "recent"]) expect(opts).toContain(`key: "${k}"`);
    expect(opts).toContain('label: "MAX LEV"');
    expect(src.match(/MARKET_SORT_OPTIONS\.map/g)).toHaveLength(2);
    // max-leverage is a SORT, highest-first — not a bucket filter.
    expect(src).toContain('case "leverage"');
  });

  it("the leverage-bucket and oracle-type FILTERS are gone (leverage is a sort now)", () => {
    // Fixed 5x/10x/20x buckets never fit a continuous, per-market, <=10x leverage cap;
    // the oracle-type filter's only real option was unused "manual".
    // (Avoid bare "MANUAL" — it survives in an unrelated isAdminOracle comment.)
    for (const gone of ["Filter by leverage", "Filter by oracle type", "5X+", "20X+", "ALL ORACLES", 'label: "MANUAL"', "leverageFilter", "oracleFilter"]) {
      expect(src).not.toContain(gone);
    }
  });
});
