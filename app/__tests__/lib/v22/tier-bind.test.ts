// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { buildInitVaultLpIx } from "@/lib/limits/p3-ix";

describe("the bind carries the edited tiers", () => {
  const k = () => Keypair.generate().publicKey;
  const m = { programId: k(), market: k(), registry: k(), vaultLpState: k(), lpPortfolio: k(), ledger: k(), siblingLedger: k() };
  const pin = { matcherProgram: k(), matcherCtx: k() };
  it("no tiers: the 5-byte growth bind (defaults)", () => {
    expect(buildInitVaultLpIx(m, k(), 2_000, pin, { lLaunchX100: 500 }).data.length).toBe(5);
  });
  it("edited tiers: tag 94 + junior floor + launch + the 18-byte block", () => {
    const ix = buildInitVaultLpIx(m, k(), 2_000, pin, { lLaunchX100: 500, tiers: { thresholdUsd: [10_000, 50_000, 200_000], leverageX100: [600, 1_200, 2_000] }, lTierX100: 2_000 });
    expect(ix.data.length).toBe(23);
    expect(ix.data[0]).toBe(94);
  });
  it("an invalid table throws before signing", () => {
    expect(() => buildInitVaultLpIx(m, k(), 2_000, pin, { lLaunchX100: 500, tiers: { thresholdUsd: [1, 2, 3], leverageX100: [0, 0, 0] }, lTierX100: 2_000 })).toThrow();
  });
});
