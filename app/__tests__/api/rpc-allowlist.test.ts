import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Verify the RPC proxy allowlist includes critical methods.
 * PERC-232: sendTransaction was missing, causing "Method not allowed" on faucet mint.
 */
describe("/api/rpc allowlist", () => {
  const routeSource = readFileSync(
    resolve(__dirname, "../../app/api/rpc/route.ts"),
    "utf-8"
  );

  it("allows sendTransaction (PERC-232)", () => {
    expect(routeSource).toContain('"sendTransaction"');
  });

  it("allows simulateTransaction", () => {
    expect(routeSource).toContain('"simulateTransaction"');
  });

  it("allows getLatestBlockhash (needed for tx building)", () => {
    expect(routeSource).toContain('"getLatestBlockhash"');
  });

  it("allows getSignatureStatuses (needed for tx confirmation)", () => {
    expect(routeSource).toContain('"getSignatureStatuses"');
  });

  it("sendTransaction is in MUTATING_METHODS (never cached)", () => {
    // Ensure sendTransaction is treated as mutating so it's never cached/deduped
    expect(routeSource).toMatch(/MUTATING_METHODS.*sendTransaction/s);
  });
});
