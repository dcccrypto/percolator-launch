// @vitest-environment node
/**
 * r9 (owner decision 2026-11-12, item 5): USDY is blocked BY MINT ONLY, like BOLD / USX / CASH. An unrelated memecoin uses the exact
 * ticker USDY, so the bare ticker and bare name no longer refuse it. Ondo USDY's verified mint and its qualified name stay refused, and
 * the rest of the yield-bearing set (sUSDe, sDAI, USDu, Solayer sUSD, syrupUSDC, ...) stays blocked by mint.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STABLECOIN_MINT_LIST, isStablecoinPerpBlocked, stablecoinIdentityVerdict } from "@/lib/v22/stablecoin-perps";
import { checkStablecoinUnderlying } from "@/lib/v22/stablecoin-resolve";

const MEMECOIN = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
const USDY_MINT = "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6";
const STILL_BY_MINT: Record<string, string> = {
  sUSDe: "Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN",
  USDu: "9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy",
  sUSD: "susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X",
  syrupUSDC: "AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj",
};

beforeEach(() => __setDevnetV22ForTest(true));
afterAll(() => __setDevnetV22ForTest(null));

describe("USDY is mint-only (r9)", () => {
  it.each(["USDY", "usdy", "$USDY", "ＵＳＤＹ", "UＳDY", "sUSDY", "wUSDY"])("symbol %s alone is not blocked", (symbol) => {
    expect(stablecoinIdentityVerdict({ symbol })).not.toBe("block");
    expect(isStablecoinPerpBlocked(MEMECOIN, { symbol })).toBe(false);
  });
  it.each(["USDY", "usdy", "Usdy"])("name %s alone is not blocked", (name) => {
    expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name })).not.toBe("block");
    expect(isStablecoinPerpBlocked(MEMECOIN, { symbol: "ZZZ", name })).toBe(false);
  });
  it("Ondo USDY's verified mint is still listed and blocked, whatever its ticker", () => {
    expect(STABLECOIN_MINT_LIST.find((m) => m.address === USDY_MINT)?.symbol).toBe("USDY");
    expect(isStablecoinPerpBlocked(USDY_MINT)).toBe(true);
    expect(isStablecoinPerpBlocked(` ${USDY_MINT}\n`)).toBe(true);
    expect(isStablecoinPerpBlocked(USDY_MINT, { symbol: "ZZZ", name: "Some Coin" })).toBe(true);
  });
  it("the qualified name Ondo US Dollar Yield is still refused", () => {
    expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name: "Ondo US Dollar Yield" })).toBe("block");
  });
  it("the other yield-bearing stables stay blocked", () => {
    for (const [sym, mint] of Object.entries(STILL_BY_MINT)) {
      if (mint) expect(isStablecoinPerpBlocked(mint), sym).toBe(true);
    }
    for (const symbol of ["sUSDe", "USDC", "USDT"]) expect(isStablecoinPerpBlocked(MEMECOIN, { symbol }), symbol).toBe(true);
    expect(STABLECOIN_MINT_LIST.length).toBe(52);
  });
});

// ---- server: on-chain metadata is what is read ----
const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const borsh = (s: string) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
function metaConn(name: string, symbol: string) {
  const mintData = Buffer.alloc(82); mintData[45] = 1;
  const metaData = Buffer.concat([Buffer.alloc(65), borsh(name), borsh(symbol)]);
  return {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((_, i) => (i % 2 === 0 ? { owner: SPL_TOKEN, data: mintData, lamports: 1, executable: false } : { owner: METAPLEX, data: metaData, lamports: 1, executable: false })),
  } as unknown as Parameters<typeof checkStablecoinUnderlying>[0]["conn"];
}

describe("server: USDY ticker memecoin accepted, Ondo USDY mint refused", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  it.each([["USDY", "USDY"], ["USDY", "usdy coin"], ["usdy", "Some Coin"]])("on-chain symbol %s / name %s is accepted", async (symbol, name) => {
    expect((await checkStablecoinUnderlying({ mainnetCa: mint, conn: metaConn(name, symbol) })).ok).toBe(true);
  });
  it("a client-supplied USDY symbol does not add a refusal", async () => {
    expect((await checkStablecoinUnderlying({ mainnetCa: mint, symbol: "USDY", conn: metaConn("Some Coin", "SOME") })).ok).toBe(true);
  });
  it("the Ondo USDY mint is refused by address", async () => {
    expect(await checkStablecoinUnderlying({ mainnetCa: USDY_MINT, conn: metaConn("Some Coin", "SOME") })).toEqual({ ok: false, kind: "stablecoin" });
  });
});
