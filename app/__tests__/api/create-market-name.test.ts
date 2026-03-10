/**
 * Tests for name field validation in /api/mobile/create-market (#998).
 *
 * The route now rejects names longer than 64 chars with HTTP 400 instead of
 * silently truncating. These tests validate the validation logic in isolation.
 */

import { describe, it, expect } from "vitest";

/**
 * Mirror of the validation logic in route.ts.
 * Returns the name string, or throws with a 400-style message if it is too long.
 */
function validateName(rawName: unknown): string {
  const name = typeof rawName === "string" ? rawName : "Mobile Market";
  if (name.length > 64) {
    throw new Error("name must be 64 characters or fewer");
  }
  return name;
}

describe("create-market name validation (#998 polish)", () => {
  it("passes through short names unchanged", () => {
    expect(validateName("BTC/USDC")).toBe("BTC/USDC");
  });

  it("rejects names longer than 64 characters with an error", () => {
    const long = "A".repeat(200);
    expect(() => validateName(long)).toThrow("name must be 64 characters or fewer");
  });

  it("allows exactly 64 characters through", () => {
    const exact = "B".repeat(64);
    expect(validateName(exact)).toHaveLength(64);
  });

  it("uses default when name is undefined", () => {
    expect(validateName(undefined)).toBe("Mobile Market");
  });

  it("uses default when name is null", () => {
    expect(validateName(null)).toBe("Mobile Market");
  });

  it("uses default when name is a number", () => {
    expect(validateName(42)).toBe("Mobile Market");
  });

  it("rejects an attacker-supplied 10k char string with an error", () => {
    const attack = "x".repeat(10_000);
    expect(() => validateName(attack)).toThrow("name must be 64 characters or fewer");
  });

  it("accepts valid unicode names within the 64-char limit", () => {
    const unicodeName = "Percolator 🔥 BTC-PERP Market 2026"; // well under 64 chars
    expect(validateName(unicodeName).length).toBeLessThanOrEqual(64);
  });
});
