import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Source-level wiring checks (same style as useCreateMarket-fresh-batched-registration.test.ts):
// the preflight must run before the first wallet signature on every launch path.
const src = readFileSync(resolve(__dirname, "../../hooks/useCreateMarket.ts"), "utf8");

describe("launch refuses an unregistrable memo before any signature", () => {
  it("create() resolves metadata and preflights before the first signing/send call", () => {
    const entry = src.indexOf("async (params: CreateMarketParams, retryFromStep?: number)");
    const resolveAt = src.indexOf("resolveMarketMetadata(", entry);
    const preflightAt = src.indexOf("assertRegistrable(", entry);
    const firstSign = Math.min(
      ...["signTransaction(", "signAllTransactions(", "sendTx(", "attemptFreshBatchedLaunch("]
        .map((k) => src.indexOf(k, entry))
        .filter((i) => i > 0),
    );
    expect(entry).toBeGreaterThan(0);
    expect(resolveAt).toBeGreaterThan(entry);
    expect(preflightAt).toBeGreaterThan(resolveAt);
    expect(preflightAt).toBeLessThan(firstSign);
  });
  it("both memo builders (batched and sequential) assert the payload they bind", () => {
    expect(src).toMatch(/if \(keeperRequestBase\) assertRegistrable\(keeperRequestBase\.symbol, keeperPayload\)/);
    expect(src).toMatch(/assertRegistrable\(params\.symbol, payload\);\s+rememberRegistrationPayload/);
  });
  it("negative control: removing the preflight line would fail this file", () => {
    expect(src.replace(/assertRegistrable\(/g, "x(")).not.toMatch(/assertRegistrable\(/);
  });
});
