// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseMarketCreationError } from "@/lib/parseMarketError";

// Error shapes captured 2026-09-29 by simulating against market
// 5T1yvECyKB66QskfTSmz4fBkgDsknrNjE5LizL6P4Xr9 on the deployed v18.2 wrapper.
const WRAPPER = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";
const TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** What broadcastSignedTx throws when the RPC preflight rejects the batched M3a. */
const M3A_PREFLIGHT_ENGINE_STALE = new Error(
  [
    "Simulation failed. ",
    "Message: Transaction simulation failed: Error processing Instruction 5: custom program error: 0x13. ",
    "Logs: ",
    `Program ${WRAPPER} invoke [1]`,
    `Program ${TOKENKEG} invoke [2]`,
    "Program log: Instruction: Transfer",
    `Program ${TOKENKEG} success`,
    `Program ${WRAPPER} success`,
    `Program ${WRAPPER} invoke [1]`,
    `Program ${WRAPPER} failed: custom program error: 0x13`,
  ].join("\n"),
);

/** What presimulateOrThrow throws for the retry's re-sent keeper hand-off. */
const RETRY_COSIGN_UNAUTHORIZED = new Error(
  `Transaction simulation failed: {"InstructionError":[0,{"Custom":8}]}\n` +
    `Program ${WRAPPER} failed: custom program error: 0x8`,
);

/** A backing seed stamped with the reserved LP-vault expiry sentinel. */
const BACKING_SENTINEL_REJECTED = new Error(
  `Transaction simulation failed: {"InstructionError":[3,{"Custom":9}]}\n` +
    `Program ${WRAPPER} failed: custom program error: 0x9`,
);

describe("parseMarketCreationError with step context", () => {
  it("funding step, EngineStale: explains a stale counter, not a stale engine that needs a crank", () => {
    const msg = parseMarketCreationError(M3A_PREFLIGHT_ENGINE_STALE, {
      step: "funding",
      stepLabel: "Funding liquidity",
    });
    expect(msg.startsWith("Funding liquidity failed:")).toBe(true);
    expect(msg).toContain("counter");
    expect(msg).toContain("Nothing from this step was applied");
    expect(msg).not.toContain("crank is needed");
    expect(msg).not.toContain("re-seed");
    // Still recognisably EngineStale for anyone reading a bug report.
    expect(msg).toContain("EngineStale");
  });

  it("CONTROL: without step context the generic EngineStale copy is unchanged (useCloseMarket relies on it)", () => {
    const msg = parseMarketCreationError(M3A_PREFLIGHT_ENGINE_STALE);
    expect(msg).toContain("crank is needed");
  });

  it("oracle-delegation step, Unauthorized: says the hand-off already happened", () => {
    const msg = parseMarketCreationError(RETRY_COSIGN_UNAUTHORIZED, {
      step: "oracle-delegation",
      stepLabel: "Step 2 (Oracle setup & pre-LP crank)",
    });
    expect(msg).toContain("already handed to the keeper");
    expect(msg).toContain("already complete");
    expect(msg).not.toContain("Ensure the correct authority wallet");
  });

  it("CONTROL: Unauthorized with no step keeps the generic authority copy", () => {
    const msg = parseMarketCreationError(RETRY_COSIGN_UNAUTHORIZED);
    expect(msg).toContain("Not authorized for this operation");
  });

  it("funding step, InvalidInstruction: names it an app-side argument rejection, not an SDK/program version mismatch", () => {
    const msg = parseMarketCreationError(BACKING_SENTINEL_REJECTED, { step: "funding" });
    expect(msg).toContain("liquidity-backing seed");
    expect(msg).not.toContain("Unknown instruction tag");
  });

  it("step context never overrides a genuine token-program insufficient-funds failure", () => {
    const msg = parseMarketCreationError(
      new Error(
        [
          `Program ${WRAPPER} invoke [1]`,
          `Program ${TOKENKEG} invoke [2]`,
          `Program ${TOKENKEG} failed: custom program error: 0x1`,
        ].join("\n"),
      ),
      { step: "funding" },
    );
    expect(msg).toContain("Insufficient token balance");
  });

  it("an unmapped code at a known step still falls through to the code table", () => {
    const msg = parseMarketCreationError(new Error("custom program error: 0x2"), { step: "lp-init" });
    expect(msg).toContain("already initialized");
  });
});
