// @vitest-environment node
/**
 * Binds the Stake page's Insurance Pools search + capped-scroll wiring to source
 * (the ordering itself is unit-tested in lib/stake-pool-order.test.ts). The
 * list previously rendered `pools.map(...)` with no search and no vertical cap,
 * so it grew unbounded; this guards that:
 *   - a search input is bound to the `query` state,
 *   - the rendered list comes from `orderStakePools(pools, query, …)`,
 *   - the rows sit in a max-height + overflow-y-auto scroll container.
 *
 * Source-binding (reads the page text) because PoolTable is a file-local
 * component and the page would need the full stake data/RPC stack to render.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../app/stake/page.tsx"),
  "utf8",
);

describe("Stake Insurance Pools — search + capped scroll", () => {
  it("orders/filters the list through orderStakePools(pools, query, …)", () => {
    expect(SRC).toContain('import { orderStakePools, stakedOrderValue } from "@/lib/stake-pool-order"');
    expect(SRC).toMatch(/stakedOrderValue\(pos\.lpBalanceRaw, pos\.estimatedValue\)/);
    expect(SRC).toMatch(/orderStakePools\(\s*pools\s*,\s*query\s*,/);
    // the list renders the derived array, not the raw prop
    expect(SRC).toContain("visiblePools.map((pool) => (");
  });

  it("has a search input bound to the query state", () => {
    expect(SRC).toMatch(/const \[query, setQuery\] = useState\(""\)/);
    expect(SRC).toMatch(/value=\{query\}/);
    expect(SRC).toMatch(/onChange=\{\(e\) => setQuery\(e\.target\.value\)\}/);
  });

  it("caps the list height and scrolls instead of growing unbounded", () => {
    expect(SRC).toMatch(/max-h-\[\d+px\] overflow-y-auto/);
  });

  it("shows a no-matches state when the filter empties the list", () => {
    expect(SRC).toContain("visiblePools.length === 0");
  });
});
