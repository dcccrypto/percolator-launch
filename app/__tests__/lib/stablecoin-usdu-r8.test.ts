// @vitest-environment node
/**
 * r8 Council finding: USDu passed the create wizard (no refusal, enabled Hold to launch). USDu and ten other verified USD
 * stables are now blocked BY MINT. Each entry carries its sources; the exact tickers stay mint-only (no ticker rule re-added).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STABLECOIN_MINT_LIST, isStablecoinPerpBlocked } from "@/lib/v22/stablecoin-perps";
import { checkStablecoinUnderlying } from "@/lib/v22/stablecoin-resolve";

const MEMECOIN = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
const ADDED: readonly (readonly [string, string])[] = [
  ["USDu", "9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy"],
  ["sUSDu", "9iq5Q33RSiz1WcupHAQKbHBZkpn92UxBG2HfPWAZhMCa"],
  ["USDGO", "72puLt71H93Z9CzHuBRTwFpL4TG3WZUhnoCC7p8gxigu"],
  ["USDP", "HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM"],
  ["sUSDai", "sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE"],
  ["USDv", "USDvUSpnhCr9yBgj3UyVrD239HRUv4RsHwH2FxsWuMk"],
  ["DUSD", "DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM"],
  ["wYLDS", "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih"],
  ["PST", "59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw"],
  ["XO", "xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y"],
  ["SOFID", "APhcqtzE73es3KAGiVksZFMLGwJDiAey5qZKUrQHEHfS"],
];

beforeEach(() => __setDevnetV22ForTest(true));
afterAll(() => __setDevnetV22ForTest(null));

describe("r8 Council finding: USDu and ten other verified USD stables", () => {
  it.each(ADDED)("%s is listed with sources and blocked by mint", (sym, addr) => {
    const e = STABLECOIN_MINT_LIST.find((m) => m.address === addr);
    expect(e?.symbol).toBe(sym);
    expect(e?.source).toMatch(/JUP/);
    expect(e?.source).toMatch(/CHAIN/);
    expect(e?.source).toMatch(/ISSUER|CG/);
    expect(isStablecoinPerpBlocked(addr)).toBe(true);
    expect(isStablecoinPerpBlocked(`  ${addr}\n`)).toBe(true);
    expect(new PublicKey(addr).toBase58()).toBe(addr);
  });
  it.each(ADDED)("%s is refused by the create-wizard underlying check", async (_s, addr) => {
    expect(await checkStablecoinUnderlying({ mainnetCa: addr })).toEqual({ ok: false, kind: "stablecoin" });
  });
  it("the list has 52 unique entries", () => {
    expect(STABLECOIN_MINT_LIST.length).toBe(52);
    expect(new Set(STABLECOIN_MINT_LIST.map((m) => m.address)).size).toBe(52);
  });
  it("a look-alike memecoin with the ticker USDu is not blocked (mint-only)", () => {
    expect(isStablecoinPerpBlocked(MEMECOIN, { symbol: "USDu" })).toBe(false);
  });
});
