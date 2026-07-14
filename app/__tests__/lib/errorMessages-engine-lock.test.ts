import { describe, expect, it } from "vitest";
import { isEngineLockError } from "../../lib/errorMessages";

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
});
