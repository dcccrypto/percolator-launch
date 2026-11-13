// @vitest-environment node
/**
 * r10 (owner decision 2026-11-13, item 5): sDAI (Savings Dai) is blocked by mint only, like USDY (r9). No genuine Solana mint of Savings
 * Dai exists, and unrelated memecoins use the exact ticker SDAI, so the exact ticker is no longer refused. DAI and the other DAI
 * wrappers stay refused; the qualified name "Savings Dai" and every verified mint stay refused.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STABLECOIN_MINT_LIST, isStablecoinPerpBlocked, stablecoinIdentityVerdict } from "@/lib/v22/stablecoin-perps";

const MEMECOIN = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
const SDAI_MEME_MINT = "C36amo6mcbr9YQ6RrY86bQa18fZK7VSCnXbBaHr8dBrE"; // "Stonk Doge AI", ticker SDAI

beforeEach(() => __setDevnetV22ForTest(true));
afterAll(() => __setDevnetV22ForTest(null));

describe("sDAI is not ticker-blocked (r10)", () => {
  it.each(["SDAI", "sDAI", "sdai", "$SDAI", "Ｓ ＤＡＩ", "SＤAI"])("symbol %s alone is not blocked", (symbol) => {
    expect(stablecoinIdentityVerdict({ symbol })).not.toBe("block");
    expect(isStablecoinPerpBlocked(MEMECOIN, { symbol })).toBe(false);
  });
  it("an SDAI memecoin (ticker SDAI, ordinary name) passes", () => {
    expect(isStablecoinPerpBlocked(SDAI_MEME_MINT, { symbol: "SDAI", name: "Stonk Doge AI" })).toBe(false);
    expect(isStablecoinPerpBlocked(MEMECOIN, { symbol: "sDAI", name: "sDAI" })).toBe(false);
  });
  it("no Solana sDAI mint is listed", () => {
    expect(STABLECOIN_MINT_LIST.some((m) => /^sdai$/i.test(m.symbol) || /savings dai/i.test(m.name))).toBe(false);
    expect(STABLECOIN_MINT_LIST.length).toBe(52);
  });
});

describe("DAI and the other DAI wrappers stay blocked", () => {
  it.each(["DAI", "dai", "$DAI", "wDAI", "aDAI", "bDAI", "xDAI", "jDAI", "stDAI", "DAIet", "DAIpo", "ＤＡＩ"])("symbol %s is refused", (symbol) => {
    expect(isStablecoinPerpBlocked(MEMECOIN, { symbol }), symbol).toBe(true);
  });
  it.each(["DAI", "Dai Stablecoin", "Savings Dai", "savings dai", "Savings DAI (Portal)"])("name %s is refused", (name) => {
    expect(isStablecoinPerpBlocked(MEMECOIN, { symbol: "ZZZ", name }), name).toBe(true);
  });
  it("names that merely contain Dai are not blocked", () => {
    for (const name of ["Savings Daisy", "Dai Fan Club"]) expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name }), name).not.toBe("block");
  });
  it("every listed verified mint is still refused, whatever its ticker", () => {
    for (const m of STABLECOIN_MINT_LIST) expect(isStablecoinPerpBlocked(m.address, { symbol: "ZZZ", name: "Some Coin" }), m.symbol).toBe(true);
  });
});
