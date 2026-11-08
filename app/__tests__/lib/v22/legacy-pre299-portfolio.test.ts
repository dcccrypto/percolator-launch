/**
 * Council 2026-11-07 round 2, finding R2-1: a holder on the OLD v2.2 wrapper 6kpg2wi7 (portfolio 10,603 B, wrapper VERSION 19,
 * engine discriminator 19: the layout before engine #299) owned 499.47 devnet USDC on a resolved market, but the app said
 * "Nothing of yours is left here". Cause: parsePortfolio only knew the post-#299 row (disc 20, 10,607 B), threw
 * DISCRIMINATOR_MISMATCH, and loadOwnPortfolios dropped the account as "not a portfolio this wire can address".
 *
 * Census of the chain (read-only getProgramAccounts, 2026-11-08): all 211 portfolios on 6kpg2wi7 are 10,603 B / VERSION 19 /
 * disc 19; all 22 on the fresh wrapper 5NGgnU2j are 10,607 B / VERSION 19 / disc 20. So the pre-#299 row is bound to the
 * wrapper the build is configured for, by discriminator AND exact length, never a blanket size acceptance:
 *   - old wrapper + legacy bytes (disc 19, 10,603 B)       -> decoded (capital, owner) and listed
 *   - fresh wrapper + legacy bytes                          -> refused (discriminator), exactly as before
 *   - old wrapper + current bytes (disc 20, 10,607 B)       -> refused
 *   - old wrapper + disc 19 at the wrong length (malformed)  -> refused
 *   - fresh wrapper + current bytes                          -> decoded, unchanged
 * The fixtures are recorded devnet portfolios of 6kpg2wi7 (pre-#299), the same files the P3 tests lift to disc 20.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_V22_PROGRAM_IDS, DEVNET_V22_FRESH_1106_PROGRAM_IDS } from "@/lib/program-ids";
import {
  activePortfolioLayout,
  isPortfolioOfActiveLayout,
  isUnsupportedLayout,
  parsePortfolio,
  portfolioAccountLen,
  portfolioGpaFilters,
} from "@/lib/v22/layout";
import { isPortfolioAccount } from "@/lib/portfolio-account";
import { loadOwnPortfolios } from "@/lib/limits/own-portfolio-cleanup";
import { liftV22Portfolio } from "../../helpers/portfolio-disc20";

const fx = (n: string): { owner: string; data: Uint8Array } => {
  const j = JSON.parse(readFileSync(path.join(__dirname, `../../fixtures/v22-growth/${n}.json`), "utf8")) as { owner: string; data: string };
  return { owner: j.owner, data: new Uint8Array(Buffer.from(j.data, "base64")) };
};
const LEGACY = fx("chillhouse-t.lp"); // recorded on 6kpg2wi7, pre-#299
const CURRENT = liftV22Portfolio(LEGACY.data); // the same account in the post-#299 layout (disc 20, 10,607 B)
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, true);

const OLD = DEVNET_V22_PROGRAM_IDS.wrapper;
const FRESH = DEVNET_V22_FRESH_1106_PROGRAM_IDS.wrapper;
const useWrapper = (w: string) => {
  vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
  vi.stubEnv("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", w);
};

/** Expected decode of the fixture, read straight from the bytes (owner @116, capital u128 @148: both below the #299 insertion). */
const expectedOwner = new PublicKey(LEGACY.data.subarray(116, 148));
const le128 = (b: Uint8Array, o: number) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]!); return v; };
const expectedCapital = le128(LEGACY.data, 148);

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => {
  __setDevnetV22ForTest(null);
  vi.unstubAllEnvs();
});

describe("fixture sanity: the recorded portfolio IS the pre-#299 layout of the old wrapper", () => {
  it("10,603 B, VERSION 19, kind 2, provenance disc 19, owned by 6kpg2wi7; the lift is 10,607 B disc 20", () => {
    expect(LEGACY.owner).toBe(OLD);
    expect(LEGACY.data.length).toBe(10_603);
    expect(u16(LEGACY.data, 8)).toBe(19);
    expect(LEGACY.data[10]).toBe(2);
    expect(u16(LEGACY.data, 114)).toBe(19);
    expect(CURRENT.length).toBe(10_607);
    expect(u16(CURRENT, 114)).toBe(20);
    expect(expectedCapital).toBeGreaterThan(0n);
  });
});

describe("old wrapper 6kpg2wi7: its pre-#299 portfolios are read with the pre-#299 row", () => {
  beforeEach(() => useWrapper(OLD));

  it("the active portfolio row is 10,603 B / disc 19, and scans ask for 10,603 B + VERSION 19", () => {
    expect(activePortfolioLayout().portfolio.accountLen).toBe(10_603);
    expect(activePortfolioLayout().engineDiscriminator).toBe(19);
    expect(portfolioAccountLen()).toBe(10_603);
    expect(portfolioGpaFilters()).toContainEqual({ dataSize: 10_603 });
  });

  it("legacy bytes decode: owner and capital match the raw bytes", () => {
    const p = parsePortfolio(LEGACY.data);
    expect(p.owner.equals(expectedOwner)).toBe(true);
    expect(p.capital).toBe(expectedCapital);
    expect(isPortfolioOfActiveLayout(LEGACY.data)).toBe(true);
    expect(isPortfolioAccount(LEGACY.data)).toBe(true);
  });

  it("current (disc 20, 10,607 B) bytes are refused here: never decoded with the wrong row", () => {
    expect(() => parsePortfolio(CURRENT)).toThrow();
    try { parsePortfolio(CURRENT); } catch (e) { expect(isUnsupportedLayout(e)).toBe(true); }
    expect(isPortfolioOfActiveLayout(CURRENT)).toBe(false);
  });

  it.each([
    ["truncated by 4 B (10,599)", () => LEGACY.data.slice(0, 10_599)],
    ["padded by 4 B (10,607) with disc 19", () => { const b = new Uint8Array(10_607); b.set(LEGACY.data); return b; }],
    ["disc 18 at 10,603 B", () => { const b = LEGACY.data.slice(); new DataView(b.buffer).setUint16(114, 18, true); return b; }],
    ["provenance version 2", () => { const b = LEGACY.data.slice(); new DataView(b.buffer).setUint16(112, 2, true); return b; }],
  ])("malformed: %s is refused", (_n, make) => {
    const b = make();
    expect(() => parsePortfolio(b)).toThrow();
    expect(isPortfolioOfActiveLayout(b)).toBe(false);
  });

  it("loadOwnPortfolios lists the holder's legacy portfolio (R2-1: the holder is no longer told 'nothing of yours')", async () => {
    const key = new PublicKey("6eyAuA4QqEYkv65mHCtD8TyoJchoP2weDiF9ZoHS4mNh");
    const market = new PublicKey(LEGACY.data.subarray(16, 48));
    const connection = { getProgramAccounts: vi.fn(async () => [{ pubkey: key, account: { data: Buffer.from(LEGACY.data), owner: new PublicKey(OLD) } }]) };
    const own = await loadOwnPortfolios(connection as never, new PublicKey(OLD), market, expectedOwner);
    expect(own).toHaveLength(1);
    expect(own[0]!.key.equals(key)).toBe(true);
    expect(own[0]!.view.capital).toBe(expectedCapital);
  });
});

describe("fresh wrapper 5NGgnU2j: unchanged — only the post-#299 row", () => {
  beforeEach(() => useWrapper(FRESH));

  it("the active row stays 10,607 B / disc 20", () => {
    expect(portfolioAccountLen()).toBe(10_607);
    expect(activePortfolioLayout().engineDiscriminator).toBe(20);
    expect(portfolioGpaFilters()).toContainEqual({ dataSize: 10_607 });
  });

  it("current bytes decode", () => {
    const p = parsePortfolio(CURRENT);
    expect(p.owner.equals(expectedOwner)).toBe(true);
    expect(p.capital).toBe(expectedCapital);
    expect(isPortfolioOfActiveLayout(CURRENT)).toBe(true);
  });

  it("legacy bytes are refused (a pre-#299 portfolio cannot exist on this wrapper)", () => {
    expect(() => parsePortfolio(LEGACY.data)).toThrow();
    expect(isPortfolioOfActiveLayout(LEGACY.data)).toBe(false);
  });
});
