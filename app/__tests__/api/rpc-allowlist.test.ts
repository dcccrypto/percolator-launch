// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Verify the RPC proxy allowlist behaviour.
 *
 * History:
 *   PERC-232: sendTransaction was missing, causing "Method not allowed" on faucet mint.
 *   PERC-8308: sendTransaction + simulateTransaction REMOVED from public proxy allowlist
 *              to prevent unauthenticated callers draining the Helius API key quota.
 *              Clients must submit transactions via their own RPC connection.
 */
describe("/api/rpc allowlist", () => {
  const routeSource = readFileSync(
    resolve(__dirname, "../../app/api/rpc/route.ts"),
    "utf-8"
  );

  // PERC-8308 originally removed sendTransaction/simulateTransaction.
  // a70eebd1: Khubair re-added them — origin guard makes them safe for
  // user-signed transactions without exposing the Helius key to abuse.
  // Tests now verify they ARE allowed (policy change) and origin guard exists.
  it("allows sendTransaction (re-enabled with origin guard)", () => {
    expect(routeSource).toMatch(/ALLOWED_RPC_METHODS[^;]*"sendTransaction"/s);
  });

  it("allows simulateTransaction (re-enabled with origin guard)", () => {
    expect(routeSource).toMatch(/ALLOWED_RPC_METHODS[^;]*"simulateTransaction"/s);
  });

  it("references PERC-8308 security decision", () => {
    expect(routeSource).toContain("PERC-8308");
  });

  // These read-only methods must remain allowed
  it("allows getLatestBlockhash (needed for tx building)", () => {
    expect(routeSource).toContain('"getLatestBlockhash"');
  });

  it("allows getSignatureStatuses (needed for tx confirmation)", () => {
    expect(routeSource).toContain('"getSignatureStatuses"');
  });

  it("has origin guard for cross-origin protection (PERC-8308)", () => {
    // isAllowedOrigin or equivalent origin check must be present
    expect(routeSource).toMatch(/isAllowedOrigin|allowedOrigin|origin.*check|403.*Forbidden|Forbidden.*403/i);
  });
});
