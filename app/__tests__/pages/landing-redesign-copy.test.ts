import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The listing-first landing (credited #3463) on the v2.2 branch: truthful label, no overclaims. */
const src = readFileSync(resolve(process.cwd(), "app/page.tsx"), "utf8");

describe("landing redesign copy (v2.2 branch)", () => {
  it("labels the network without a program version this build may not run", () => {
    expect(src).toContain("// solana devnet");
    expect(src).not.toMatch(/\/\/ v1\d · /);
    expect(src).not.toMatch(/devnet v2 · solana/);
  });
  it("leads with listing, not the old no-rug headline", () => {
    expect(src).toContain("Perps on Solana tokens;");
    expect(src).not.toMatch(/can&apos;t rug you/);
  });
  it("keeps the scoped admin-burn card and makes no Pyth or mainnet claim", () => {
    expect(src).toContain("body: ADMIN_BURN_COPY.landing");
    expect(src).not.toMatch(/pyth/i);
    expect(src).not.toMatch(/mainnet/i);
  });
  it("describes Earn as a share of trading fees, not all of them", () => {
    expect(src).toContain("for a share of its trading fees");
    expect(src).not.toMatch(/earn its\s+fees/);
  });
});
