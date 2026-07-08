/**
 * PERC-8445: Lighthouse/Blowfish error classification in humanizeError.
 *
 * Verifies that 0x1900 errors from Lighthouse are shown as user-friendly
 * messages instead of raw hex codes.
 */
import { humanizeError, LIGHTHOUSE_USER_MESSAGE } from "@/lib/errorMessages";

const LIGHTHOUSE_PROGRAM_ID_STR = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

describe("humanizeError — Lighthouse/Blowfish detection", () => {
  it("classifies 0x1900 Anchor ConstraintAddress as Lighthouse error", () => {
    const raw = `Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1900`;
    expect(humanizeError(raw)).toBe(LIGHTHOUSE_USER_MESSAGE);
  });

  it("classifies error mentioning Lighthouse program ID", () => {
    const raw = `Program ${LIGHTHOUSE_PROGRAM_ID_STR} failed: custom program error: 0x1790`;
    expect(humanizeError(raw)).toBe(LIGHTHOUSE_USER_MESSAGE);
  });

  it("classifies JSON InstructionError with Custom 6400", () => {
    const raw = `{"InstructionError":[3,{"Custom":6400}]} — ${LIGHTHOUSE_PROGRAM_ID_STR}`;
    expect(humanizeError(raw)).toBe(LIGHTHOUSE_USER_MESSAGE);
  });

  it("does NOT classify generic 0x31 (Percolator error 49) as Lighthouse", () => {
    const raw = `Transaction simulation failed: custom program error: 0x31`;
    const result = humanizeError(raw);
    expect(result).not.toBe(LIGHTHOUSE_USER_MESSAGE);
    expect(result).toContain("Insufficient margin");
  });

  it("does NOT classify generic unknown errors as Lighthouse", () => {
    const raw = `User rejected the request.`;
    expect(humanizeError(raw)).toBe("Transaction cancelled.");
  });

  it("still handles blockhash expiry correctly (no Lighthouse false positive)", () => {
    const raw = `Blockhash not found`;
    const result = humanizeError(raw);
    expect(result).toContain("expired");
  });
});
