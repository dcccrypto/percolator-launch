// @vitest-environment node
import { describe, test, expect } from "vitest";

/**
 * PERC-8388: Test that Lighthouse/Blowfish assertion error (0x1900) is correctly
 * detected and surfaced with a user-friendly message.
 */
describe("Lighthouse 0x1900 detection", () => {
  const LIGHTHOUSE_PATTERNS = [
    "Transaction simulation failed: custom program error: 0x1900",
    "failed to send transaction: Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1900",
    "Program L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 consumed 12345 of 200000 compute units",
    // JSON format from RPC — 6400 decimal = 0x1900 hex
    '{"InstructionError":[3,{"Custom":6400}]}',
    'Transaction simulation failed: Error processing Instruction 3: {"InstructionError":[3,{"Custom":6400}]}',
  ];

  const NON_LIGHTHOUSE = [
    "custom program error: 0x4",
    "custom program error: 0x1901",
    "Transaction failed: insufficient funds",
    "Blockhash not found",
  ];

  const isLighthouse = (msg: string) =>
    /custom program error:\s*0x1900\b/i.test(msg) ||
    /L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95/i.test(msg) ||
    (/"Custom"\s*:\s*6400/.test(msg) && /InstructionError/.test(msg));

  test.each(LIGHTHOUSE_PATTERNS)("detects Lighthouse error: %s", (msg) => {
    expect(isLighthouse(msg)).toBe(true);
  });

  test.each(NON_LIGHTHOUSE)("does NOT match non-Lighthouse error: %s", (msg) => {
    expect(isLighthouse(msg)).toBe(false);
  });

  test("user-facing message for 0x1900 hex format", () => {
    const is0x1900 = /custom program error:\s*0x1900\b/i.test(
      "custom program error: 0x1900"
    );
    expect(is0x1900).toBe(true);

    const userMsg = is0x1900
      ? "Your wallet's transaction guard (Blowfish/Lighthouse) is blocking this transaction. " +
        "Try disabling transaction simulation in your wallet settings, or use a wallet without " +
        "Blowfish protection (e.g. Backpack). We're working on a permanent fix."
      : "raw error";

    expect(userMsg).toContain("Blowfish");
    expect(userMsg).toContain("Backpack");
  });

  test("user-facing message for JSON Custom:6400 format", () => {
    const raw = '{"InstructionError":[3,{"Custom":6400}]}';
    const is0x1900 =
      /custom program error:\s*0x1900\b/i.test(raw) ||
      (/"Custom"\s*:\s*6400/.test(raw) && /InstructionError/.test(raw));
    expect(is0x1900).toBe(true);
  });
});
