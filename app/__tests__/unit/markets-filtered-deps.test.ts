/**
 * S26: /markets' list memo (`filtered`) reads `activeMarkets` but listed `effectiveMarkets` as its
 * dependency. `activeMarkets` also depends on the connected wallet (a creator sees their own market
 * while its price is awaited), so after a connect or switch the list kept the previous wallet's rows
 * until the next stats refresh (up to 30 s), while the count above it, read from `activeMarkets`,
 * was already right. Source check, like the other /markets page tests.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(path.resolve(__dirname, "../../app/markets/page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("/markets list memo dependencies", () => {
  it("the filtered list re-derives when activeMarkets changes", () => {
    const start = src.indexOf("const filtered = useMemo(() => {");
    const body = src.slice(start, src.indexOf("\n  }, [", start) + 120);
    // The list starts from `shownMarkets` (activeMarkets narrowed by the lifecycle filter), which itself re-derives with activeMarkets.
    expect(body).toContain("let list = shownMarkets;");
    expect(body).toMatch(/\n {2}\}, \[shownMarkets, /);
    const shown = src.slice(src.indexOf("const shownMarkets = useMemo("));
    expect(shown.slice(0, shown.indexOf("\n  );"))).toContain("[activeMarkets, lifecycles, lifecycleFilter]");
  });
  it("retired markets are left out of the default list, and the state filter is wired to ?state=", () => {
    expect(src).toContain("matchesLifecycleFilter(lifecycles.get(m.slabAddress)?.state");
    expect(src).toContain('params.set("state", lifecycleFilter)');
  });
});
