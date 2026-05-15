import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { isKnownProgram, assertKnownProgram } from "@/lib/programAllowlist";
import { getAllProgramIds } from "@/lib/config";

// vitest.config.ts pins NEXT_PUBLIC_DEFAULT_NETWORK=devnet for tests, so
// getAllProgramIds() returns the devnet set: default + small/medium/large.

describe("programAllowlist", () => {
  it("accepts every program ID returned by getAllProgramIds()", () => {
    const ids = getAllProgramIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(isKnownProgram(id)).toBe(true);
      expect(isKnownProgram(new PublicKey(id))).toBe(true);
    }
  });

  it("rejects an attacker-controlled program ID", () => {
    // Synthetic — must not collide with any real deployed program.
    const attacker = "11111111111111111111111111111112";
    expect(isKnownProgram(attacker)).toBe(false);
    expect(isKnownProgram(new PublicKey(attacker))).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isKnownProgram(null)).toBe(false);
    expect(isKnownProgram(undefined)).toBe(false);
  });

  it("assertKnownProgram throws on a foreign program ID", () => {
    const attacker = new PublicKey("11111111111111111111111111111112");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => assertKnownProgram(attacker)).toThrow(/not owned by a recognized/i);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("assertKnownProgram throws on null/undefined", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => assertKnownProgram(null)).toThrow();
      expect(() => assertKnownProgram(undefined)).toThrow();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("assertKnownProgram does NOT echo the bad program ID in the thrown message", () => {
    const attacker = new PublicKey("11111111111111111111111111111112");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      try {
        assertKnownProgram(attacker);
        throw new Error("expected throw");
      } catch (e) {
        expect((e as Error).message).not.toContain(attacker.toBase58());
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  it("assertKnownProgram is a no-op for an allowed program", () => {
    const allowed = getAllProgramIds()[0];
    expect(() => assertKnownProgram(allowed)).not.toThrow();
    expect(() => assertKnownProgram(new PublicKey(allowed))).not.toThrow();
  });

  it("getAllProgramIds() includes the cluster's matcherProgramId", async () => {
    // Slabs are owned by the matcher program; without this entry the gate
    // rejects every legitimate market on mainnet.
    const { getConfig } = await import("@/lib/config");
    const cfg = getConfig();
    const ids = getAllProgramIds();
    expect(ids).toContain(cfg.matcherProgramId);
    expect(isKnownProgram(cfg.matcherProgramId)).toBe(true);
  });
});
