import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The deployed wrapper program writes to the market account in CreateLpVault
 * (tag 74). Whether the installed SDK's ACCOUNTS_CREATE_LP_VAULT marks
 * `market` writable depends on WHICH SNAPSHOT of the git-pinned SDK the
 * install resolved — the version string says 3.0.0 either way, but the
 * known-good tree the hosted deploy was reverted to (fba2a6d) ships it
 * read-only, which made every hosted wizard "Create Earn vault" step fail
 * on-chain with error 7 (AccountNotWritable), surfaced as "Unexpected
 * error". Proven by devnet simulation: read-only → 0x7 at ~1.8k CU;
 * writable → past the check (0x8 Unauthorized for a non-marketauth signer,
 * the next gate).
 *
 * The wizard therefore force-sets the flag itself — a no-op on SDK
 * snapshots that already carry the fix, the bugfix on the ones that don't.
 * Safe to delete only once the SDK bump has actually shipped to the hosted
 * deploy.
 */
describe("CreateLpVault market-writable override", () => {
  it("useCreateMarket overrides the market meta to writable (wizard step 5)", () => {
    const source = readFileSync(
      resolve(__dirname, "../../hooks/useCreateMarket.ts"),
      "utf8",
    );
    expect(source).toContain("marketMeta.isWritable = true");
    expect(source).toContain("AccountNotWritable");
  });

  it("useInsuranceLP overrides the market meta too (Earn page's createMint)", () => {
    // Same instruction, second call site — the Earn page's admin
    // "create vault" action fails identically without the override.
    const source = readFileSync(
      resolve(__dirname, "../../hooks/useInsuranceLP.ts"),
      "utf8",
    );
    expect(source).toContain("marketMeta.isWritable = true");
    expect(source).toContain("AccountNotWritable");
  });
});
