import { describe, it, expect } from "vitest";
import { PERCOLATOR_ERRORS } from "@percolatorct/sdk";
import { mapCreatorClaimError } from "@/lib/creatorClaimError";

/**
 * Error mapping for WithdrawCreatorFee (tag 90).
 *
 * Ordinals come from the v17 PercolatorError enum, cross-checked here against
 * the SDK's PERCOLATOR_ERRORS table so a future enum reshuffle fails the test
 * rather than silently mislabelling a revert: 8=Unauthorized,
 * 9=InvalidInstruction (amount == 0), 21=EngineLockActive,
 * 25=EngineCounterUnderflow, 62=CreatorFeeOverClaim.
 *
 * 47/48 (insurance cooldown / ceiling) are NOT tag-90 codes — the handler
 * applies neither gate — so they must fall through to the shared table rather
 * than being dressed up as claim-specific advice.
 */
describe("mapCreatorClaimError — ordinals match the SDK error table", () => {
  it("62 is CreatorFeeOverClaim and 25 is EngineCounterUnderflow", () => {
    expect(PERCOLATOR_ERRORS[62]?.name).toBe("CreatorFeeOverClaim");
    expect(PERCOLATOR_ERRORS[25]?.name).toBe("EngineCounterUnderflow");
    expect(PERCOLATOR_ERRORS[9]?.name).toBe("InvalidInstruction");
    expect(PERCOLATOR_ERRORS[8]?.name).toBe("Unauthorized");
    expect(PERCOLATOR_ERRORS[21]?.name).toBe("EngineLockActive");
  });
});

describe("mapCreatorClaimError", () => {
  it("maps Custom(62) to an exact-amount over-claim message (JSON error form)", () => {
    const msg = mapCreatorClaimError('Transaction failed: {"InstructionError":[0,{"Custom":62}]}');
    expect(msg).toMatch(/exceeds the creator fees/i);
    expect(msg).toMatch(/exact-amount/i);
    expect(msg).toMatch(/nothing was deducted/i);
    expect(msg).not.toMatch(/transaction failed/i);
  });

  it("Custom(62) never tells the user a partial claim went through", () => {
    const msg = mapCreatorClaimError('{"Custom":62}');
    expect(msg).not.toMatch(/partially|partial fill|some of/i);
  });

  it("maps Custom(9) to a zero-amount message, not the shared matcher-config text", () => {
    const msg = mapCreatorClaimError("Program failed: Custom(9)");
    expect(msg).toMatch(/zero|nothing to claim/i);
    expect(msg).not.toMatch(/matcher/i);
  });

  it("maps Custom(8) Unauthorized to an operator-specific message", () => {
    const msg = mapCreatorClaimError("custom program error: 0x8");
    expect(msg).toMatch(/insurance operator|creator wallet/i);
    expect(msg).not.toMatch(/vault token account/i);
  });

  it("maps Custom(21) EngineLockActive to retry advice, NOT the trade-flow re-seed text", () => {
    const msg = mapCreatorClaimError('{"Custom":21}');
    expect(msg).toMatch(/try again later|smaller amount/i);
    expect(msg).toMatch(/nothing was deducted/i);
    expect(msg).not.toMatch(/re-seed/i);
    expect(msg).not.toMatch(/position size/i);
  });

  it("maps Custom(25) as an internal invariant break, never as user error", () => {
    const msg = mapCreatorClaimError("Custom(25)");
    expect(msg).toMatch(/report this/i);
    expect(msg).toMatch(/nothing was claimed/i);
  });

  it("does NOT invent a cooldown for Custom(47) — tag 90 has no cooldown gate", () => {
    // Tag 57 was rate-limited by insurance_withdraw_cooldown_slots. Tag 90 is
    // not, so 47 must fall through to the shared table with its plain meaning
    // rather than being re-phrased as "your creator fees are on cooldown".
    const msg = mapCreatorClaimError('{"Custom":47}');
    expect(msg).toMatch(/insurance withdrawal cooldown/i);
    expect(msg).not.toMatch(/creator fees can only be claimed/i);
  });

  it("does NOT invent a ceiling for Custom(48)", () => {
    const msg = mapCreatorClaimError('{"Custom":48}');
    expect(msg).toMatch(/ceiling|deposits-only/i);
    expect(msg).not.toMatch(/configured for this market\.$/i);
  });

  it("falls back to humanizeError for unrelated errors (user rejection)", () => {
    const msg = mapCreatorClaimError("User rejected the request");
    expect(msg).toMatch(/cancel/i);
  });

  it("handles JSON, Custom(N) and hex forms equivalently", () => {
    const json = mapCreatorClaimError('{"Custom":62}');
    const enumForm = mapCreatorClaimError("Custom(62)");
    const hex = mapCreatorClaimError("custom program error: 0x3e"); // 0x3e = 62
    expect(enumForm).toBe(json);
    expect(hex).toBe(json);
  });
});
