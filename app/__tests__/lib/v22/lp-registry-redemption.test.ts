/**
 * Review F5: the installed SDK 8.0.0 parseLpVaultRegistry / parseLpRedemption assert VERSION 18 and throw on a v2.2
 * (VERSION 19) account. The adapter in lib/v22/records.ts is VERSION-keyed with the flag on and the installed function with it off.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { parseLpRedemption as installedRedemption, parseLpVaultRegistry as installedRegistry } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ACCOUNT_KIND, UnknownLayoutError } from "@/lib/v22/sdk";
import { parseLpRedemption, parseLpVaultRegistry } from "@/lib/v22/records";
import { put128, stampHeader } from "./_stamp";

afterEach(() => __setDevnetV22ForTest(null));
const market = Keypair.generate().publicKey;
const redeemer = Keypair.generate().publicKey;

function registry(version: number): Uint8Array {
  const d = stampHeader(new Uint8Array(176), ACCOUNT_KIND.LpVaultRegistry, version);
  d.set(market.toBytes(), 16);
  put128(d, 16 + 64, 987_654n); // total_lp_shares_outstanding
  return d;
}
function redemption(version: number, len = 112): Uint8Array {
  const d = stampHeader(new Uint8Array(len), ACCOUNT_KIND.LpRedemption, version);
  d.set(redeemer.toBytes(), 16 + 32);
  put128(d, 16 + 64, 5_555n); // shares
  return d;
}

describe("flag on: VERSION 19 decodes", () => {
  it("registry", () => {
    __setDevnetV22ForTest(true);
    expect(parseLpVaultRegistry(registry(19)).totalLpSharesOutstanding).toBe(987_654n);
    expect(parseLpVaultRegistry(registry(18)).totalLpSharesOutstanding).toBe(987_654n); // v2.1 accounts still read
  });
  it("redemption: 112 B legacy and 128 B v2.2-form requests", () => {
    __setDevnetV22ForTest(true);
    expect(parseLpRedemption(redemption(19)).shares).toBe(5_555n);
    expect(parseLpRedemption(redemption(19, 128)).shares).toBe(5_555n);
    expect(parseLpRedemption(redemption(19)).redeemer.toBase58()).toBe(redeemer.toBase58());
  });
  it("NEGATIVE CONTROL: the installed SDK parsers throw on VERSION 19", () => {
    expect(() => installedRegistry(registry(19))).toThrow(/invalid v17 version \(19 !== 18\)/);
    expect(() => installedRedemption(redemption(19))).toThrow(/invalid v17 version/);
  });
  it("an unknown VERSION is the typed UnknownLayoutError", () => {
    __setDevnetV22ForTest(true);
    expect(() => parseLpVaultRegistry(registry(20))).toThrow(UnknownLayoutError);
    expect(() => parseLpRedemption(redemption(20))).toThrow(UnknownLayoutError);
  });
  it("the wrong account kind is refused", () => {
    __setDevnetV22ForTest(true);
    const d = registry(19);
    d[10] = ACCOUNT_KIND.Portfolio;
    expect(() => parseLpVaultRegistry(d)).toThrow();
  });
});

describe("flag off: parity with the installed SDK", () => {
  it("same results on VERSION 18; VERSION 19 still throws exactly as before", () => {
    expect(parseLpVaultRegistry(registry(18))).toEqual(installedRegistry(registry(18)));
    expect(parseLpRedemption(redemption(18))).toEqual(installedRedemption(redemption(18)));
    expect(() => parseLpVaultRegistry(registry(19))).toThrow(/invalid v17 version/);
  });
});

describe("no caller imports the version-asserting parsers from the installed SDK", () => {
  it("source guard", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files = ["hooks/useInsuranceLP.ts", "hooks/useEarnStats.ts", "hooks/useCreateMarket.ts", "lib/limits/earn-split-pot.ts", "lib/limits/earn-positions.ts", "lib/pre-resolve.ts", "lib/v21/move/scan.ts"];
    for (const f of files) {
      const src = readFileSync(join(__dirname, "../../..", f), "utf8");
      const sdkImports = [...src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@percolatorct\/sdk['"]/g)].map((m) => m[1]).join(",");
      expect(sdkImports, f).not.toMatch(/\bparseLp(VaultRegistry|Redemption)\b/);
    }
  });
});
