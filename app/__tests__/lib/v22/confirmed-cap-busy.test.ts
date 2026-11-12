// @vitest-environment node
/**
 * Council r9 recheck NEW-1: a confirmed order signs the chain cap PLUS room for the busy-side rate it confirmed (the wrapper refuses a 98 when
 * base + matcher request + util > fee_bps). Real market + matcher bytes (SOL / JUP / CHILLHOUSE, fee-channel fixture).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { fetchTradeFeeBps, resolveTradeFeeBps } from "@/lib/limits/trade-fee-resolve";

const FEE = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-fee-channel-2026-10-11.json"), "utf8")) as { markets: Record<string, Record<string, string>> };
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

describe("resolveTradeFeeBps with a confirmed busy-side rate", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __setDevnetV21ForTest(true); });
  afterEach(() => { __setDevnetV22ForTest(null); __setDevnetV21ForTest(null); });

  it.each(["SOL", "JUP", "CHILLHOUSE"])("%s: 0 confirmed = exactly the old 135; a 500 bps confirmed rate = 135 + 500 capped at the market maximum; matcher drift fits", (sym) => {
    const m = FEE.markets[sym];
    const marketData = b64(m.marketB64), matcherCtxData = b64(m.matcherCtxB64);
    const old = resolveTradeFeeBps({ marketData, matcherCtxData })!;
    expect(old.feeBps).toBe(135n);
    expect(resolveTradeFeeBps({ marketData, matcherCtxData, confirmedUtilFeeBps: 0n })!.feeBps).toBe(135n);
    const busy = resolveTradeFeeBps({ marketData, matcherCtxData, confirmedUtilFeeBps: 500n })!;
    const want = 135n + 500n;
    expect(busy.feeBps).toBe(want < busy.maxFeeBps ? want : busy.maxFeeBps);
    expect(busy.feeBps).toBeGreaterThan(old.feeBps);
    // the real f8 case: confirm showed 99 bps (30 base + 23 quote + 46 busy), the matcher moved 23 -> 30: needs 30 + 30 + 46 = 106 <= the cap
    const f8 = resolveTradeFeeBps({ marketData, matcherCtxData, confirmedUtilFeeBps: 46n })!;
    expect(f8.feeBps).toBe(181n);
    expect(f8.feeBps >= 106n).toBe(true);
    // the forced-1x busy Max: 30 + 23 + 498 = 551 must fit under the signed cap (it was refused at 135)
    const max = resolveTradeFeeBps({ marketData, matcherCtxData, confirmedUtilFeeBps: 498n })!;
    expect(max.feeBps >= 551n || max.feeBps === max.maxFeeBps).toBe(true);
    expect(max.feeBps).toBeGreaterThan(551n - 1n);
  });
  it("never above the market's max_trading_fee_bps", () => {
    const m = FEE.markets.SOL;
    const r = resolveTradeFeeBps({ marketData: b64(m.marketB64), matcherCtxData: b64(m.matcherCtxB64), confirmedUtilFeeBps: 100_000n })!;
    expect(r.feeBps).toBe(r.maxFeeBps);
  });
  it("an unreadable market falls back to the legacy fee PLUS the confirmed rate (still room for it); no rate = the legacy fee", async () => {
    const failing = { getMultipleAccountsInfo: vi.fn(async () => { throw new Error("rpc"); }) };
    const k = PublicKey.default;
    expect(await fetchTradeFeeBps(failing, k, k, { fallback: 30n, confirmedUtilFeeBps: 498n })).toBe(528n);
    expect(await fetchTradeFeeBps(failing, k, k, { fallback: 30n })).toBe(30n);
    expect(await fetchTradeFeeBps(failing, k, k, { fallback: 30n, confirmedUtilFeeBps: 0n })).toBe(30n);
  });
});
