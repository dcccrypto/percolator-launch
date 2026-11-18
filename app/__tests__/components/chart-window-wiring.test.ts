/**
 * Binds the chart-window fix to the source.
 *
 * `__tests__/lib/chart-window.test.ts` covers the window table. It cannot see
 * whether the hook actually USES it, or whether it still sends the right
 * resolution string — and both of those are where the risk is. Same technique, and the same reason, as
 * create-market-launch-gate.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const PERC = fs.readFileSync(
  path.resolve(__dirname, "../../hooks/usePercolatorCandles.ts"),
  "utf8",
);

describe("the candle source uses the shared window table", () => {
  it("the hook does not hard-code its own lookback numbers", () => {
    for (const [name, src] of [["usePercolatorCandles", PERC]] as const) {
      expect(src, name).toContain("CHART_WINDOWS");
      // the old shape: `lookbackSec: 2 * 3600` / `lookbackSecs: 8 * 3600`
      expect(src, name).not.toMatch(/lookbackSecs?:\s*\d+\s*\*\s*3600/);
      expect(src, name).not.toMatch(/lookbackSecs?:\s*\d+\s*\*\s*86400/);
    }
  });
});

describe("the source keeps the resolution string its own API expects", () => {
  it("the UDF candles route gets 1D for daily, never bare D", () => {
    expect(PERC).toMatch(/"1d":\s*"1D"/);
  });
});

describe("the window actually reaches the request", () => {
  it("the hook derives `from` from the shared lookback, not a literal", () => {
    // The regexes above only prove CHART_WINDOWS is imported. A mutant that
    // imports it and then writes `const from = to - 7200` reintroduces the
    // original bug and passes every one of them. Pin the derivation itself.
    expect(PERC).toMatch(/const\s+from\s*=\s*to\s*-\s*lookbackSec\s*;/);
  });

  it("the empty short-circuit actually returns before fetching", () => {
    // Asserting that `emptyCache.get` appears somewhere does not prove the
    // fetch is skipped: deleting the `return`, inverting the comparison, or
    // moving the block below the fetch all leave the call in place.
    const block = PERC.slice(
      PERC.indexOf("const emptyAt = emptyCache.get("),
      PERC.indexOf("if (endpointUnavailable)"),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/isFresh\(\s*emptyAt\s*,\s*EMPTY_CACHE_TTL_MS\s*\)/);
    // isFresh must stay a real 0 <= age < ttl window (an inverted comparison would never short-circuit).
    expect(PERC).toMatch(/const\s+age\s*=\s*Date\.now\(\)\s*-\s*at\s*;\s*return\s+age\s*>=\s*0\s*&&\s*age\s*<\s*ttlMs\s*;/);
    expect(block).toMatch(/return\s*;/);
    // ...and it must sit ahead of the network call, not after it.
    expect(PERC.indexOf("const emptyAt = emptyCache.get(")).toBeLessThan(
      PERC.indexOf("await fetch(`/api/candles/"),
    );
  });

  it("a live trade drops the remembered emptiness", () => {
    // Otherwise the user's own first fill is hidden behind the TTL.
    expect(PERC).toMatch(/emptyCache\.delete\(`\$\{slabAddress\}:\$\{timeframe\}`\)/);
  });
});

describe("an empty answer is remembered briefly, not re-fetched every click", () => {
  it("no_data is cached with a TTL rather than discarded", () => {
    // /api/candles costs 600-1400ms. Previously `no_data` was never cached, so
    // on an unindexed market — most of them — every timeframe click re-paid
    // that round trip for an answer that had not changed.
    expect(PERC).toContain("EMPTY_CACHE_TTL_MS");
    expect(PERC).toMatch(/emptyCache\.get\(/);
    expect(PERC).toMatch(/boundedSet\(\s*emptyCache/);
  });

  it("CONTROL: the TTL is short, so a newly indexed market still appears", () => {
    // Without a bound this becomes the bug the original comment warned about:
    // "a market whose candles simply haven't been indexed yet would then paint
    // blank from cache forever". Must stay well under the 10-minute success
    // cache.
    const m = PERC.match(/EMPTY_CACHE_TTL_MS\s*=\s*([0-9_]+)/);
    expect(m, "EMPTY_CACHE_TTL_MS must be a literal").not.toBeNull();
    const ttl = Number(m![1].replace(/_/g, ""));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120_000);
  });
});
