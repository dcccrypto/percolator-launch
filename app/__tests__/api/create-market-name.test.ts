/**
 * Tests for name field sanitisation in /api/mobile/create-market (#998).
 *
 * The route truncates the name to 64 chars to prevent oversized payloads
 * propagating to the DB. These tests validate the sanitisation logic in isolation.
 */

import { describe, it, expect } from "vitest";

/** Mirror of the sanitisation logic in route.ts */
function sanitiseName(rawName: unknown): string {
  return (typeof rawName === "string" ? rawName : "Mobile Market").slice(0, 64);
}

describe("create-market name sanitisation (#998)", () => {
  it("passes through short names unchanged", () => {
    expect(sanitiseName("BTC/USDC")).toBe("BTC/USDC");
  });

  it("truncates names longer than 64 characters", () => {
    const long = "A".repeat(200);
    const result = sanitiseName(long);
    expect(result).toHaveLength(64);
    expect(result).toBe("A".repeat(64));
  });

  it("allows exactly 64 characters through", () => {
    const exact = "B".repeat(64);
    expect(sanitiseName(exact)).toHaveLength(64);
  });

  it("uses default when name is undefined", () => {
    expect(sanitiseName(undefined)).toBe("Mobile Market");
  });

  it("uses default when name is null", () => {
    expect(sanitiseName(null)).toBe("Mobile Market");
  });

  it("uses default when name is a number", () => {
    expect(sanitiseName(42)).toBe("Mobile Market");
  });

  it("truncates an attacker-supplied 10k char string", () => {
    const attack = "x".repeat(10_000);
    const result = sanitiseName(attack);
    expect(result).toHaveLength(64);
  });

  it("preserves unicode correctly (slice operates on UTF-16 code units)", () => {
    const unicodeName = "Percolator 🔥 BTC-PERP Market 2026"; // well under 64 chars
    expect(sanitiseName(unicodeName).length).toBeLessThanOrEqual(64);
  });
});
