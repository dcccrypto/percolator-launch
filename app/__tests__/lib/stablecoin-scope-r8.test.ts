// @vitest-environment node
/**
 * r8: the ticker / name rule no longer catches the exact tickers BOLD, USX and CASH (unrelated memecoins use them); those are
 * blocked BY MINT ONLY. Also pins the two new mints (Solayer sUSD, Maple syrupUSDC) and that sUSDe / USDY / sDAI stay blocked.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STABLECOIN_MINT_LIST, foldIdentity, isStablecoinPerpBlocked, stablecoinIdentityVerdict } from "@/lib/v22/stablecoin-perps";
import { checkStablecoinUnderlying } from "@/lib/v22/stablecoin-resolve";

const MEMECOIN = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
const USX_MINT = "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG";
const CASH_MINT = "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH";
const SUSD_MINT = "susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X";
const SYRUP_MINT = "AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj";

beforeEach(() => __setDevnetV22ForTest(true));
afterAll(() => __setDevnetV22ForTest(null));

describe("r8 new mints", () => {
  it.each([["sUSD", SUSD_MINT], ["syrupUSDC", SYRUP_MINT]])("%s is listed with a source and blocked by mint", (sym, addr) => {
    const e = STABLECOIN_MINT_LIST.find((m) => m.address === addr);
    expect(e?.symbol).toBe(sym);
    expect(e?.source).toContain("ISSUER");
    expect(isStablecoinPerpBlocked(addr)).toBe(true);
    expect(isStablecoinPerpBlocked(`  ${addr}\n`)).toBe(true);
    expect(new PublicKey(addr).toBase58()).toBe(addr);
  });
  it("the list has 52 unique entries", () => {
    expect(STABLECOIN_MINT_LIST.length).toBe(52);
    expect(new Set(STABLECOIN_MINT_LIST.map((m) => m.address)).size).toBe(52);
  });
});

describe("BOLD / USX / CASH are mint-only", () => {
  it.each(["BOLD", "bold", "$BOLD", "USX", "usx", "CASH", "cash", "$CASH", "ВOLD" /* Cyrillic В */, "CΑSH" /* Greek Α */, "ＣＡＳＨ", "US​X", "ＵＳＸ"])(
    "symbol %s alone is not blocked",
    (symbol) => {
      expect(stablecoinIdentityVerdict({ symbol })).not.toBe("block");
      expect(isStablecoinPerpBlocked(MEMECOIN, { symbol })).toBe(false);
    },
  );
  it.each(["Bold", "BOLD", "Cash", "CASH", "USX", "usx"])("name %s alone is not blocked", (name) => {
    expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name })).not.toBe("block");
    expect(isStablecoinPerpBlocked(MEMECOIN, { symbol: "ZZZ", name })).toBe(false);
  });
  it("the folded forms are plain ASCII tickers (homoglyphs do not re-catch them)", () => {
    expect(foldIdentity("ВOLD")).toBe("BOLD");
    expect(foldIdentity("CΑSH")).toBe("CASH");
    expect(stablecoinIdentityVerdict({ symbol: foldIdentity("ВOLD") })).not.toBe("block");
  });
  it.each([["USX", USX_MINT], ["CASH", CASH_MINT]])("the verified %s mint is still blocked, whatever its ticker", (_s, mint) => {
    expect(isStablecoinPerpBlocked(mint)).toBe(true);
    expect(isStablecoinPerpBlocked(mint, { symbol: "BOLD" })).toBe(true);
  });
  it("qualified stable names are still refused", () => {
    for (const name of ["Solstice USX", "Liquity BOLD", "Liquity USD"]) expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name }), name).toBe("block");
  });
});

describe("sUSDe / USDY / sDAI stay blocked", () => {
  it("by symbol, name and mint (USDY: mint and qualified name only, r9)", () => {
    for (const symbol of ["sUSDe"]) expect(isStablecoinPerpBlocked(MEMECOIN, { symbol }), symbol).toBe(true);
    for (const name of ["Staked USDe", "Ondo US Dollar Yield", "Savings Dai", "savings dai"]) expect(isStablecoinPerpBlocked(MEMECOIN, { symbol: "ZZZ", name }), name).toBe(true);
    for (const addr of ["Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN", "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"]) expect(isStablecoinPerpBlocked(addr), addr).toBe(true);
  });
  it("a name that merely contains Dai is not blocked", () => {
    for (const name of ["Savings Daisy", "Dai Fan Club"]) expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name }), name).not.toBe("block");
  });
});

// ---- server: on-chain metadata of the mint is what is read -------------------------------------------------------------------
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

describe("server: non-stable mint with a BOLD / USX / CASH ticker is accepted", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  it.each([["BOLD", "Bold"], ["USX", "USX"], ["CASH", "Cash"], ["CASH", "CASH"]])("on-chain symbol %s / name %s", async (symbol, name) => {
    const r = await checkStablecoinUnderlying({ mainnetCa: mint, conn: metaConn(name, symbol) });
    expect(r.ok).toBe(true);
  });
  it.each(["BOLD", "USX", "CASH"])("client-supplied symbol %s does not add a refusal", async (symbol) => {
    expect((await checkStablecoinUnderlying({ mainnetCa: mint, symbol, conn: metaConn("Some Coin", "SOME") })).ok).toBe(true);
  });
  it.each([["sUSDe", "Staked USDe"], ["USDY", "Ondo US Dollar Yield"], ["ZZZ", "Savings Dai"]])("on-chain %s is still refused", async (symbol, name) => {
    expect(await checkStablecoinUnderlying({ mainnetCa: mint, conn: metaConn(name, symbol) })).toEqual({ ok: false, kind: "stablecoin" });
  });
  it.each([USX_MINT, CASH_MINT, SUSD_MINT, SYRUP_MINT])("mint %s is refused by address on the server", async (m) => {
    expect(await checkStablecoinUnderlying({ mainnetCa: m, conn: metaConn("Some Coin", "SOME") })).toEqual({ ok: false, kind: "stablecoin" });
  });
});
