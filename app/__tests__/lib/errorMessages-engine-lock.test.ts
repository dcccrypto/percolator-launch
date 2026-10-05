import { describe, expect, it } from "vitest";
import { humanizeError, isEngineLockError } from "../../lib/errorMessages";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

describe("isEngineLockError", () => {
  it("detects engine stale/lock errors by numeric code", () => {
    // 19 = EngineStale
    expect(isEngineLockError("custom program error: 0x13")).toBe(true);
    expect(isEngineLockError('Error: {"InstructionError":[0,{"Custom":19}]}')).toBe(true);

    // 21 = EngineLockActive
    expect(isEngineLockError("custom program error: 0x15")).toBe(true);
    expect(isEngineLockError('Error: {"InstructionError":[0,{"Custom":21}]}')).toBe(true);
  });

  it("does not classify oracle/transient errors as engine lock errors", () => {
    // 20/26/27 are handled by oracle stale/transient paths, not engine-lock sticky UX.
    expect(isEngineLockError("custom program error: 0x14")).toBe(false);
    expect(isEngineLockError("custom program error: 0x1a")).toBe(false);
    expect(isEngineLockError("custom program error: 0x1b")).toBe(false);

    expect(isEngineLockError("Transaction cancelled by user")).toBe(false);
    expect(isEngineLockError("random wallet error")).toBe(false);
  });

  it("P2b: 120/121/122 (split out of 21) are engine-lock errors with calm, specific copy (Devnet v2.1 flag on)", () => {
    __setDevnetV21ForTest(true);
    // 120 = 0x78 EngineAdlReduceOnly, 121 = 0x79 EngineLossStale, 122 = 0x7a EarnExitWouldUnderBackClaims
    expect(isEngineLockError("custom program error: 0x78")).toBe(true);
    expect(isEngineLockError('Error: {"InstructionError":[2,{"Custom":121}]}')).toBe(true);
    expect(isEngineLockError("custom program error: 0x7a")).toBe(true);
    // Neighbours are not: 119 / 123 are unassigned.
    expect(isEngineLockError("custom program error: 0x77")).toBe(false);
    expect(isEngineLockError("custom program error: 0x7b")).toBe(false);
    // The copy is shown only when the WRAPPER raised the code (origin-gated by program id).
    const w = resolveDevnetProgramIds().wrapper;
    const raised = (hex: string) => `Program ${w} failed: custom program error: 0x${hex}`;
    expect(humanizeError(raised("78"), "trade")).toMatch(/close-only while it rebalances/);
    expect(humanizeError(raised("79"), "trade")).toMatch(/being refreshed/);
    expect(humanizeError(raised("7a"), "trade")).toMatch(/under-backed/);
    __setDevnetV21ForTest(null);
  });

  it("CONTROL (today's programs, flag off): 120/121/122 are NOT engine locks and keep no special copy", () => {
    __setDevnetV21ForTest(false);
    expect(isEngineLockError("custom program error: 0x78")).toBe(false);
    expect(isEngineLockError("custom program error: 0x7a")).toBe(false);
    const w = resolveDevnetProgramIds().wrapper;
    expect(humanizeError(`Program ${w} failed: custom program error: 0x78`, "trade")).not.toMatch(/close-only while it rebalances/);
    __setDevnetV21ForTest(null);
  });
});
