import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";

const PROGRAM_ID = new PublicKey("EXsr2Tfz8ntWYP3vgCStdknFBoafvJQugJKAh4nFdo8f");
const SLAB = new PublicKey("11111111111111111111111111111111");

describe("deriveVaultAuthority", () => {
  it("returns deterministic results", () => {
    const [pda1, bump1] = deriveVaultAuthority(PROGRAM_ID, SLAB);
    const [pda2, bump2] = deriveVaultAuthority(PROGRAM_ID, SLAB);
    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);
    expect(bump1).toBeGreaterThanOrEqual(0);
    expect(bump1).toBeLessThanOrEqual(255);
  });

  it("different slabs produce different PDAs", () => {
    const slab2 = PublicKey.unique();
    const [pda1] = deriveVaultAuthority(PROGRAM_ID, SLAB);
    const [pda2] = deriveVaultAuthority(PROGRAM_ID, slab2);
    expect(pda1.equals(pda2)).toBe(false);
  });
});

describe("deriveLpPda", () => {
  it("returns deterministic results", () => {
    const [pda1, bump1] = deriveLpPda(PROGRAM_ID, SLAB, 0);
    const [pda2, bump2] = deriveLpPda(PROGRAM_ID, SLAB, 0);
    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);
  });

  it("different indices produce different PDAs", () => {
    const [pda1] = deriveLpPda(PROGRAM_ID, SLAB, 0);
    const [pda2] = deriveLpPda(PROGRAM_ID, SLAB, 1);
    expect(pda1.equals(pda2)).toBe(false);
  });
});
