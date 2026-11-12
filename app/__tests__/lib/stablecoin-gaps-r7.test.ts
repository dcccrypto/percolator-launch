// @vitest-environment node
/**
 * r7: widen the v2.2 stablecoin block.
 *  - tickers / names that were not refused (USD+, acUSD, eUSX, GHO, FRAX; BOLD / USX / CASH are mint-only since r8, see stablecoin-scope-r8.test.ts) or only warned (TUSD, BUSD, USDT0, RLUSD, USDtb, JupUSD);
 *  - homoglyph / zero-width / fullwidth tickers fold to the real ticker, without false positives on ordinary tokens;
 *  - the newly verified mints;
 *  - sUSDe, USDY and sDAI stay blocked (USDY by mint and qualified name only since r9);
 *  - server: no identity is refused, a failed metadata read fails closed, a pool differing from the slab's pinned dex_pool is a mismatch.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STABLECOIN_MINT_LIST, foldIdentity, isStablecoinPerpBlocked, stablecoinIdentityVerdict } from "@/lib/v22/stablecoin-perps";
import { checkStablecoinUnderlying, slabPinnedPoolMismatch } from "@/lib/v22/stablecoin-resolve";

const CONTROL = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";

beforeEach(() => __setDevnetV22ForTest(true));
afterAll(() => __setDevnetV22ForTest(null));

describe("newly refused tickers", () => {
  it.each(["USD+", "usd+", "USD +", "acUSD", "ACUSD", "eUSX", "GHO", "FRAX", "TUSD", "BUSD", "USDT0", "RLUSD", "USDtb", "JupUSD", "JUPUSD", "sRLUSD", "wUSDtb"])(
    "symbol %s is a hard block",
    (symbol) => {
      expect(stablecoinIdentityVerdict({ symbol })).toBe("block");
      expect(isStablecoinPerpBlocked(CONTROL, { symbol })).toBe(true);
    },
  );

  it.each(["USD+", "Overnight USD+", "Solstice USX", "Solstice eUSX", "Aave GHO", "Frax", "Frax Dollar", "Liquity BOLD", "TrueUSD", "Binance USD", "USDT0", "Ripple USD", "RLUSD", "Ethena USDtb", "Jupiter USD", "Wrapped CUSD (Allbridge from Celo)"])(
    "name %s is a hard block",
    (name) => expect(stablecoinIdentityVerdict({ symbol: "XYZ", name })).toBe("block"),
  );

  it("keeps sUSDe, USDY and sDAI blocked (symbol, name and mint; USDY by mint and name only since r9)", () => {
    for (const symbol of ["sUSDe", "sDAI"]) expect(isStablecoinPerpBlocked(CONTROL, { symbol }), symbol).toBe(true);
    for (const name of ["Staked USDe", "Ondo US Dollar Yield"]) expect(isStablecoinPerpBlocked(CONTROL, { symbol: "ZZZ", name }), name).toBe(true);
    for (const addr of ["Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN", "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"]) expect(isStablecoinPerpBlocked(addr), addr).toBe(true);
  });

  it("is a no-op off v2.2", () => {
    __setDevnetV22ForTest(false);
    expect(isStablecoinPerpBlocked(CONTROL, { symbol: "USD+" })).toBe(false);
    expect(isStablecoinPerpBlocked(CONTROL, { symbol: "UЅDC" })).toBe(false);
  });
});

describe("homoglyph / invisible-character tickers", () => {
  it.each([
    ["Cyrillic Ѕ (U+0405) in USDC", "UЅDC"],
    ["Cyrillic С (U+0421) in USDC", "USDС"],
    ["Cyrillic U-less: Cyrillic Т in USDT", "USDТ"],
    ["Greek Α in FRAX", "FRΑX"],
    ["Cyrillic lower с in usdc", "usdс"],
    ["fullwidth USDC", "ＵＳＤＣ"],
    ["zero-width space inside USDC", "US​DC"],
    ["zero-width joiner + BOM", "﻿USD‍T"],
    ["soft hyphen inside PYUSD", "PY­USD"],
    ["combining mark on USDC", "USDĆ"],
    ["Cyrillic О in USDe-style RLUSD (R L U S D) with Greek Ο in GHO", "GHΟ"],
    ["Armenian Ս (U+054D) in USDC", "\u054DSDC"],
    ["Cherokee Ꮪ (U+13DA) in USDC", "U\u13DADC"],
    ["Cherokee Ꮯ (U+13DF) in USDC", "USD\u13DF"],
    ["fullwidth plus USD+", "USD＋"],
  ])("%s is refused", (_n, symbol) => {
    expect(stablecoinIdentityVerdict({ symbol })).toBe("block");
    expect(isStablecoinPerpBlocked(CONTROL, { symbol })).toBe(true);
  });

  it("homoglyph names are folded too", () => {
    expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name: "Ха UЅD Coin".replace("Ха ", "") })).toBe("block");
    expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name: "Tеther USD" })).toBe("block"); // Cyrillic е
    expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name: "Pay​Pal USD" })).toBe("block");
  });

  it("foldIdentity maps lookalikes and strips invisibles, and leaves ASCII alone", () => {
    expect(foldIdentity("UЅDC")).toBe("USDC");
    expect(foldIdentity("US​‍DC")).toBe("USDC");
    expect(foldIdentity("BONK")).toBe("BONK");
  });

  it.each(["ТОКЕН", "ΑΛΦΑ", "ドル", "美元", "الدولار", "ДАИ", "БОЛД", "\u{1F680}", "SOL​", "ÉCLAIR", "BONK", "WIF", "JUP", "CASH", "cash", "USX", "BOLD", "CΑSH", "ВOLD", "ＵＳＸ", "CASHCAT", "SCASH", "XCASH", "GHOST", "BOLDER", "FRAXIL", "USDUC", "USDP", "USDARK", "JUST", "BUST", "TRUST", "CUSD1", "USDT0X", "USXR", "TUSDC1", "BUSDRIVER"])(
    "ordinary token %s is NOT a hard block (no false positive)",
    (symbol) => expect(stablecoinIdentityVerdict({ symbol })).not.toBe("block"),
  );

  it.each(["Bold", "Cash", "USX", "Bold Fox", "Cash Cat", "Ghost", "Frax Fan Club", "Solana Cash Machine", "Frozen Frax", "Dollar Dog", "USD Coin Maxi"])(
    "ordinary name %s is NOT a hard block",
    (name) => expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name })).not.toBe("block"),
  );

  it("the JUST / BUST exact-ticker protections still hold with the fold in place", () => {
    for (const symbol of ["JUST", "BUST", "AUST", "SUST", "WUST", "STUST", "JLUST", "XUST"]) expect(stablecoinIdentityVerdict({ symbol }), symbol).not.toBe("block");
    expect(stablecoinIdentityVerdict({ symbol: "UST" })).toBe("block");
  });
});

describe("newly added mints", () => {
  const added: Record<string, string> = {
    "USD+": "usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia",
    CASH: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",
    USX: "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG",
    eUSX: "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC",
    JupUSD: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
    acUSD: "EwxNF8g9UfmsJVcZFTpL9Hx5MCkoQFoJi6XNWzKf1j8e",
    FRAX: "FR87nWEUxVgerFGhZM8Y4AggKGLnaXswr1Pd8wZ4kZcp",
  };
  it.each(Object.entries(added))("%s mint is listed with a source and blocked", (sym, addr) => {
    const e = STABLECOIN_MINT_LIST.find((m) => m.address === addr);
    expect(e?.symbol).toBe(sym);
    expect(e?.source.length).toBeGreaterThan(20);
    expect(isStablecoinPerpBlocked(addr)).toBe(true);
  });
});

// ---- server -------------------------------------------------------------------------------------------------------------------
const fakeConn = (opts: { fail?: boolean } = {}) =>
  ({ getMultipleAccountsInfo: async (keys: unknown[]) => { if (opts.fail) throw new Error("rpc down"); return keys.map(() => null); } }) as unknown as Parameters<typeof checkStablecoinUnderlying>[0]["conn"];

describe("server gaps", () => {
  it("neither a pool nor a mainnet_ca: refused (no-identity), even with a clean client symbol", async () => {
    expect(await checkStablecoinUnderlying({ conn: fakeConn() })).toEqual({ ok: false, kind: "no-identity" });
    expect(await checkStablecoinUnderlying({ symbol: "OK", name: "Okay", conn: fakeConn() })).toEqual({ ok: false, kind: "no-identity" });
    __setDevnetV22ForTest(false);
    expect(await checkStablecoinUnderlying({ conn: fakeConn() })).toEqual({ ok: true });
  });

  it("a failed metadata read fails closed with a retryable verdict", async () => {
    expect(await checkStablecoinUnderlying({ mainnetCa: CONTROL, conn: fakeConn({ fail: true }) })).toEqual({ ok: false, kind: "unverifiable", retryable: true });
  });

  it("a pool that differs from the slab's pinned dex_pool is a mismatch; same / unpinned is not", () => {
    const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
    expect(slabPinnedPoolMismatch(a, b)).toBe(true);
    expect(slabPinnedPoolMismatch(a, a)).toBe(false);
    expect(slabPinnedPoolMismatch(a, null)).toBe(false);
    expect(slabPinnedPoolMismatch(null, b)).toBe(false);
  });
});
