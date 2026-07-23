import { describe, it, expect } from "vitest";
import { mapCreatorClaimError } from "@/lib/creatorClaimError";

/**
 * Verifies tag-57 (WithdrawInsuranceAsset) error mapping. Ordinals come from the
 * v17 PercolatorError enum (NOT the stale app-wide ERROR_CODE_MAP, which uses
 * v12 ordinals): 8=Unauthorized, 9=InvalidInstruction(amount 0), 21=EngineLockActive,
 * 47=InsuranceWithdrawCooldownActive, 48=InsuranceWithdrawCeilingExceeded.
 */
describe("mapCreatorClaimError", () => {
  it("maps Custom(47) to a specific cooldown message (JSON error form)", () => {
    const msg = mapCreatorClaimError('Transaction failed: {"InstructionError":[0,{"Custom":47}]}');
    expect(msg).toMatch(/cooldown/i);
    expect(msg).not.toMatch(/transaction failed/i);
  });

  it("maps Custom(48) to a specific ceiling message", () => {
    const msg = mapCreatorClaimError('{"Custom":48}');
    expect(msg).toMatch(/ceiling/i);
  });

  it("maps Custom(8) Unauthorized to an operator-specific message (NOT the stale 'vault' text)", () => {
    const msg = mapCreatorClaimError("custom program error: 0x8");
    expect(msg).toMatch(/authoriz|operator|creator/i);
    expect(msg).not.toMatch(/vault token account/i);
  });

  it("maps Custom(9) to a 'nothing to claim' message", () => {
    const msg = mapCreatorClaimError("Program failed: Custom(9)");
    expect(msg).toMatch(/nothing to claim|no accrued/i);
  });

  it("maps Custom(21) EngineLockActive to a withdrawable-capacity message (NOT 'position size')", () => {
    const msg = mapCreatorClaimError('{"Custom":21}');
    expect(msg).toMatch(/withdrawable|reserved|capacity|smaller/i);
    expect(msg).not.toMatch(/position size/i);
  });

  it("falls back to humanizeError for unrelated errors (user rejection)", () => {
    const msg = mapCreatorClaimError("User rejected the request");
    expect(msg).toMatch(/cancel/i);
  });

  it("handles Custom(N) enum form and hex form equivalently", () => {
    expect(mapCreatorClaimError("Custom(47)")).toMatch(/cooldown/i);
    expect(mapCreatorClaimError("custom program error: 0x2f")).toMatch(/cooldown/i); // 0x2f = 47
  });
});
