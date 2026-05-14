/**
 * Referral code generator — format + uniqueness contract.
 *
 * The route relies on the generator producing codes that match the SQL
 * unique constraint's alphabet and length. If either drifts, signups will
 * either reject codes that should be valid or generate codes the SQL
 * function would refuse.
 */

import { describe, it, expect } from "vitest";
import {
  generateReferralCode,
  isValidReferralCodeShape,
  REFERRAL_CODE_LENGTH,
} from "@/lib/waitlist/referralCode";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

describe("generateReferralCode", () => {
  it("returns the expected length by default", () => {
    expect(generateReferralCode().length).toBe(REFERRAL_CODE_LENGTH);
  });

  it("uses only Crockford base32 characters (no I/L/O/U, no lowercase)", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateReferralCode();
      for (const ch of code) {
        expect(CROCKFORD_ALPHABET).toContain(ch);
      }
    }
  });

  it("produces unique codes across a large sample (no collisions at this scale)", () => {
    const N = 10_000;
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) seen.add(generateReferralCode());
    expect(seen.size).toBe(N);
  });

  it("rejects lengths outside the supported range", () => {
    expect(() => generateReferralCode(3)).toThrow();
    expect(() => generateReferralCode(65)).toThrow();
  });
});

describe("isValidReferralCodeShape", () => {
  it("accepts a freshly generated code", () => {
    expect(isValidReferralCodeShape(generateReferralCode())).toBe(true);
  });

  it("rejects lowercase, wrong length, and confusable chars", () => {
    expect(isValidReferralCodeShape("abc23xyz")).toBe(false); // lowercase
    expect(isValidReferralCodeShape("ABC23X")).toBe(false); // too short
    expect(isValidReferralCodeShape("ABC23XYZ9")).toBe(false); // too long
    expect(isValidReferralCodeShape("ABCI3XYZ")).toBe(false); // contains I
    expect(isValidReferralCodeShape("ABCL3XYZ")).toBe(false); // contains L
    expect(isValidReferralCodeShape("ABCO3XYZ")).toBe(false); // contains O
    expect(isValidReferralCodeShape("ABCU3XYZ")).toBe(false); // contains U
  });
});
