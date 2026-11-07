// @vitest-environment node
/**
 * Wiring guard for the runtime price-WS URL (lib/price-ws-url.ts; Council 2026-11-06-go1106-ux, Operator): every
 * client reader goes through getPriceWsUrl(), the root layout loads /api/runtime-config before hydration, and the
 * CSP allows the URL resolved at request time. A new direct `process.env.NEXT_PUBLIC_WS_URL` read would quietly
 * bring back the build-time-only behaviour for that caller.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = process.cwd();
const read = (f: string) => readFileSync(join(APP, f), "utf8");
/** Source without comments, so a doc comment naming the variable is not a read. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const CLIENT_READERS = [
  "lib/priceStore/priceStore.ts",
  "lib/tv/data/index.ts",
  "hooks/usePercolatorCandles.ts",
];

describe("runtime price-WS URL wiring", () => {
  it("no client caller reads NEXT_PUBLIC_WS_URL directly; they all call getPriceWsUrl()", () => {
    for (const f of CLIENT_READERS) {
      expect(code(f), f).not.toMatch(/process\.env\.NEXT_PUBLIC_WS_URL/);
      expect(code(f), f).toMatch(/getPriceWsUrl\(\)/);
    }
  });

  it("the price store resolves the URL when it connects, not once at module load", () => {
    expect(code("lib/priceStore/priceStore.ts")).not.toMatch(/const WS_URL\s*=/);
  });

  it("the root layout loads the runtime-config script before hydration", () => {
    const layout = code("app/layout.tsx");
    expect(layout).toMatch(/RUNTIME_CONFIG_PATH/);
    expect(layout).toMatch(/strategy="beforeInteractive"/);
  });

  it("the middleware CSP allows the request-time URL", () => {
    const mw = code("middleware.ts");
    expect(mw).toMatch(/priceWsConnectSrc\(resolveServerPriceWsUrl\(process\.env\)\)/);
    expect(mw).not.toMatch(/priceWsConnectSrc\(process\.env\.NEXT_PUBLIC_WS_URL\)/);
  });
});
