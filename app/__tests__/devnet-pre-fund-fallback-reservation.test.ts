import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("devnet-pre-fund fallback gate reservation", () => {
  const routeSource = readFileSync(
    join(process.cwd(), "app/api/devnet-pre-fund/route.ts"),
    "utf8",
  );

  it("reserves the in-memory fallback gate before transaction construction", () => {
    const reserveIndex = routeSource.indexOf(
      "Reserve the in-memory fallback gate immediately before mint work",
    );
    const txIndex = routeSource.indexOf("const tx = new Transaction();");

    expect(reserveIndex).toBeGreaterThan(-1);
    expect(txIndex).toBeGreaterThan(-1);
    expect(reserveIndex).toBeLessThan(txIndex);
  });

  it("re-checks and records the fallback limiter before minting", () => {
    expect(routeSource).toContain("if (usingInMemoryFallbackGate)");
    expect(routeSource).toContain("const { limited, nextClaimAt } = _preFundIsLimited(rateKey)");
    expect(routeSource).toContain("_preFundRecord(rateKey)");
    expect(routeSource).toContain("reservedInMemoryFallbackGate = true");
  });

  it("releases the in-memory fallback gate when mint transaction fails", () => {
    const txCatchIndex = routeSource.indexOf("catch (txErr)");
    const releaseAfterTxCatchIndex = routeSource.indexOf(
      "releaseInMemoryFallbackGate();",
      txCatchIndex,
    );

    expect(txCatchIndex).toBeGreaterThan(-1);
    expect(releaseAfterTxCatchIndex).toBeGreaterThan(txCatchIndex);
  });

  it("does not double-record fallback reservations on success", () => {
    expect(routeSource).toContain("if (!reservedInMemoryFallbackGate)");
  });
});
