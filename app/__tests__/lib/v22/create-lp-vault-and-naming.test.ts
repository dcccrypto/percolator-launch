// @vitest-environment node
/**
 * v2.2 (flag on): tag 74 `CreateLpVault` carries the market's collateral mint as account [6] at EVERY call site, and the launch names
 * the share token (tag 122) right after it, signed by marketauth, before any handoff. Flag off: byte-identical to the v2.1 launch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ACCOUNTS_CREATE_LP_VAULT, IX_TAG, deriveInsuranceLpMint, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { createLpVaultKeys } from "@/lib/v22/create-lp-vault";
import { isShareNamingEnabled, shareTickerFor } from "@/lib/v22/share-naming";
import { METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, deriveLpShareMetaPayerPdaV22, deriveLpShareMetadataPdaV22 } from "@/lib/v22/sdk";
import { buildEarnVaultSeedInstructions } from "@/lib/earn-vault-seed";
import { buildMobileFundingIxs } from "@/lib/mobile-market-funding-ixs";

afterEach(() => {
  __setDevnetV22ForTest(null);
  delete process.env.NEXT_PUBLIC_DEVNET_V22_SHARE_NAMING;
});

const k = () => Keypair.generate().publicKey;
const mint = k();
const base = () => {
  const programId = k(), market = k();
  return {
    programId, market, wallet: k(), registry: deriveLpVaultRegistry(programId, market)[0], lpMint: deriveInsuranceLpMint(programId, market)[0],
    userAta: k(), vaultAta: k(), seedPerDomain: 1_000_000_000n, includeCreate: true,
  };
};
const tags = (ixs: { data: Uint8Array }[]) => ixs.map((i) => i.data[0]);

describe("flag off: the v2.1 launch is unchanged", () => {
  it("[74 six accounts, ATA, 75, 75] and no tag 122, collateralMint / shareSymbol ignored", () => {
    __setDevnetV22ForTest(false);
    const a = base();
    const ixs = buildEarnVaultSeedInstructions({ ...a, collateralMint: mint, shareSymbol: "SOL" });
    expect(tags(ixs.map((i) => ({ data: i.data })))).toEqual([IX_TAG.CreateLpVault, 1 /* ATA createIdempotent */, IX_TAG.DepositToLpVault, IX_TAG.DepositToLpVault]);
    expect(ACCOUNTS_CREATE_LP_VAULT).toHaveLength(6); // the installed SDK 8.0.0 spec is the six-account list
    expect(ixs[0].keys).toHaveLength(6);
    expect(ixs.some((i) => i.data[0] === 122 && i.programId.equals(a.programId))).toBe(false);
    // same list whether or not a mint is passed
    const without = buildEarnVaultSeedInstructions(a);
    expect(without.map((i) => Buffer.from(i.data).toString("hex"))).toEqual(ixs.map((i) => Buffer.from(i.data).toString("hex")));
    expect(without[0].keys.map((m) => m.pubkey.toBase58())).toEqual(ixs[0].keys.map((m) => m.pubkey.toBase58()));
    expect(isShareNamingEnabled()).toBe(false);
  });
});

describe("flag on: tag 74 [6] = collateral mint, then tag 122 (signed by marketauth)", () => {
  it("order is 74, 122, ATA, 75, 75; 74 has 7 accounts with [6] read-only; 122 is the ticker form with the wallet as payer AND marketauth", () => {
    __setDevnetV22ForTest(true);
    const a = base();
    const ixs = buildEarnVaultSeedInstructions({ ...a, collateralMint: mint, shareSymbol: "1000pepe" });
    expect(ixs.map((i) => i.programId.equals(a.programId) ? i.data[0] : "x")).toEqual([IX_TAG.CreateLpVault, 122, "x", IX_TAG.DepositToLpVault, IX_TAG.DepositToLpVault]);
    expect(ixs[0].keys).toHaveLength(7);
    expect(ixs[0].keys[6]).toMatchObject({ isSigner: false, isWritable: false });
    expect(ixs[0].keys[6].pubkey.equals(mint)).toBe(true);
    expect(ixs[0].keys.slice(0, 6).map((m) => m.pubkey.toBase58())).toEqual([a.wallet, a.market, a.registry, a.lpMint, SystemProgram.programId, new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")].map((x) => x.toBase58()));
    const n = ixs[1];
    expect(Buffer.from(n.data).toString("hex")).toBe("7a08" + Buffer.from("1000PEPE").toString("hex")); // [122][8]["1000PEPE"]
    expect(n.keys).toHaveLength(9);
    expect(n.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(n.keys[0].pubkey.equals(a.wallet)).toBe(true);
    expect(n.keys[1].pubkey.equals(a.registry)).toBe(true);
    expect(n.keys[2].pubkey.equals(a.lpMint)).toBe(true);
    expect(n.keys[3].pubkey.equals(deriveLpShareMetadataPdaV22(a.lpMint)[0])).toBe(true);
    expect(n.keys[4].pubkey.equals(METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22)).toBe(true);
    expect(n.keys[6].pubkey.equals(deriveLpShareMetaPayerPdaV22(a.programId, a.lpMint)[0])).toBe(true);
    expect(n.keys[7].pubkey.equals(a.market)).toBe(true);
    expect(n.keys[8]).toMatchObject({ isSigner: true });
    expect(n.keys[8].pubkey.equals(a.wallet)).toBe(true); // marketauth
  });
  it("no symbol (or nothing A-Z0-9 left) = the generic form [122, 0] with 7 accounts", () => {
    __setDevnetV22ForTest(true);
    for (const sym of [undefined, null, "", "日本", "$-."]) {
      const ixs = buildEarnVaultSeedInstructions({ ...base(), collateralMint: mint, shareSymbol: sym });
      expect([...ixs[1].data]).toEqual([122, 0]);
      expect(ixs[1].keys).toHaveLength(7);
    }
  });
  it("the app's 20-char symbols reduce to a program-valid ticker", () => {
    expect(shareTickerFor("abc.def-ghi_jklmnopq")).toBe("ABCDEFGH");
    expect(shareTickerFor("$WIF")).toBe("WIF");
    expect(shareTickerFor(undefined)).toBe("");
  });
  it("the collateral mint is REQUIRED with the flag on (the six-account form is refused on chain)", () => {
    __setDevnetV22ForTest(true);
    expect(() => buildEarnVaultSeedInstructions({ ...base() })).toThrow(/collateral mint/);
    expect(() => buildEarnVaultSeedInstructions({ ...base(), collateralMint: null })).toThrow(/collateral mint/);
  });
  it("a resume without a create (registry exists) emits neither 74 nor 122", () => {
    __setDevnetV22ForTest(true);
    const ixs = buildEarnVaultSeedInstructions({ ...base(), includeCreate: false, collateralMint: mint, shareSymbol: "SOL" });
    expect(ixs.map((i) => i.data[0])).toEqual([1, IX_TAG.DepositToLpVault, IX_TAG.DepositToLpVault]);
  });
  it("the kill switch NEXT_PUBLIC_DEVNET_V22_SHARE_NAMING=0 drops tag 122 but keeps the 7-account tag 74", () => {
    __setDevnetV22ForTest(true);
    process.env.NEXT_PUBLIC_DEVNET_V22_SHARE_NAMING = "0";
    expect(isShareNamingEnabled()).toBe(false);
    const ixs = buildEarnVaultSeedInstructions({ ...base(), collateralMint: mint, shareSymbol: "SOL" });
    expect(ixs.map((i) => i.data[0])).toEqual([IX_TAG.CreateLpVault, 1, IX_TAG.DepositToLpVault, IX_TAG.DepositToLpVault]);
    expect(ixs[0].keys).toHaveLength(7);
  });
  it("naming is BEFORE any marketauth handoff by construction: 122 sits inside the vault-create group, ahead of both deposits", () => {
    __setDevnetV22ForTest(true);
    const ixs = buildEarnVaultSeedInstructions({ ...base(), collateralMint: mint, shareSymbol: "SOL" });
    const i74 = ixs.findIndex((i) => i.data[0] === 74), i122 = ixs.findIndex((i) => i.data[0] === 122), i75 = ixs.findIndex((i) => i.data[0] === 75);
    expect(i74).toBeLessThan(i122);
    expect(i122).toBeLessThan(i75);
  });
});

describe("createLpVaultKeys (shared by every call site)", () => {
  const a = () => ({ admin: k(), market: k(), registry: k(), lpMint: k() });
  it("flag on: 7 accounts; without a mint it throws; flag off: 6 accounts and the mint is ignored", () => {
    __setDevnetV22ForTest(true);
    expect(createLpVaultKeys({ ...a(), collateralMint: mint })).toHaveLength(7);
    expect(() => createLpVaultKeys(a())).toThrow();
    __setDevnetV22ForTest(false);
    expect(createLpVaultKeys({ ...a(), collateralMint: mint })).toHaveLength(6);
    expect(createLpVaultKeys(a())).toHaveLength(6);
  });
});

describe("mobile funding (TX4, non-fatal group)", () => {
  const p = () => {
    const programId = k();
    return { programId, market: k(), lpPortfolio: k(), deployer: k(), userAta: k(), vaultAta: k() };
  };
  it("flag on: TX4 = 74 (7 accounts, [6] = mint), 122 (ticker from the symbol), ATA, 75, 75; the mandatory group has no Metaplex", () => {
    __setDevnetV22ForTest(true);
    const f = buildMobileFundingIxs({ ...p(), collateralMint: mint, shareSymbol: "wif" });
    expect(f.backingSeeds.map((i) => i.data[0])).toEqual([IX_TAG.CreateLpVault, 122, 1, IX_TAG.DepositToLpVault, IX_TAG.DepositToLpVault]);
    expect(f.backingSeeds[0].keys).toHaveLength(7);
    expect(f.backingSeeds[0].keys[6].pubkey.equals(mint)).toBe(true);
    expect(Buffer.from(f.backingSeeds[1].data).toString("hex")).toBe("7a03" + Buffer.from("WIF").toString("hex"));
    const meta = METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22.toBase58();
    expect(f.mandatory.some((i) => i.keys.some((m) => m.pubkey.toBase58() === meta))).toBe(false); // R11: the load-bearing group never touches Metaplex
  });
  it("flag on, no symbol: the generic form", () => {
    __setDevnetV22ForTest(true);
    const f = buildMobileFundingIxs({ ...p(), collateralMint: mint });
    expect([...f.backingSeeds[1].data]).toEqual([122, 0]);
  });
  it("flag off: the v2.1 TX4 exactly (six accounts, no 122)", () => {
    __setDevnetV22ForTest(false);
    const f = buildMobileFundingIxs({ ...p(), collateralMint: mint, shareSymbol: "wif" });
    expect(f.backingSeeds.map((i) => i.data[0])).toEqual([IX_TAG.CreateLpVault, 1, IX_TAG.DepositToLpVault, IX_TAG.DepositToLpVault]);
    expect(f.backingSeeds[0].keys).toHaveLength(6);
  });
  it("sanity: the ATA program is untouched", () => {
    __setDevnetV22ForTest(true);
    const f = buildMobileFundingIxs({ ...p(), collateralMint: mint });
    expect(f.backingSeeds[2].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  });
});

describe("CostEstimate", () => {
  it("flag on: the share-token record is in the breakdown and the total; flag off: no field at all (breakdown byte-identical)", async () => {
    const { computeCreateMarketSolCost } = await import("@/components/create/CostEstimate");
    __setDevnetV22ForTest(false);
    const off = computeCreateMarketSolCost({ p3: true });
    expect("shareNamingSol" in off).toBe(false);
    __setDevnetV22ForTest(true);
    const on = computeCreateMarketSolCost({ p3: true });
    expect(on.shareNamingSol).toBeCloseTo(0.0151156, 7);
    // the rest of the total moves only through the layout (slab 4,059 B, portfolio 10,603 B), not through naming
    process.env.NEXT_PUBLIC_DEVNET_V22_SHARE_NAMING = "0";
    const noName = computeCreateMarketSolCost({ p3: true });
    expect("shareNamingSol" in noName).toBe(false);
    expect(on.totalSolCost - noName.totalSolCost).toBeCloseTo(0.0151156, 7);
  });
});
