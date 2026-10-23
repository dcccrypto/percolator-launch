// @vitest-environment node
/** v2.2 QA U-2 / P-3b: a 98 is rebuilt once with a cap that covers the utilisation fee; a second 98 is the true reason. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { isUtilFeeNotCovered, resolveTradeFeeBps, sendWithUtilFeeRetry, UtilFeeOverMaxError, utilFeeMaxBpsOf } from "@/lib/limits/trade-fee-resolve";
import { resolveUserMessage } from "@/lib/limits/user-message";

const FEE = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-fee-channel-2026-10-11.json"), "utf8")) as { markets: Record<string, Record<string, string>> };
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const e98 = () => Object.assign(new Error('Transaction simulation failed: {"InstructionError":[3,{"Custom":98}]}'), { name: "SimulationRefusal", code: 98 });

describe("U-2: the fee cap after a 98", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __setDevnetV21ForTest(true); });
  afterEach(() => { __setDevnetV22ForTest(null); __setDevnetV21ForTest(null); });

  it.each(["SOL", "JUP", "CHILLHOUSE"])("%s (real market + matcher bytes): 135 first, then base + matcher + the asset's utilisation maximum, capped at the market maximum", (sym) => {
    const m = FEE.markets[sym];
    const marketData = b64(m.marketB64), matcherCtxData = b64(m.matcherCtxB64);
    const first = resolveTradeFeeBps({ marketData, matcherCtxData })!;
    const raised = resolveTradeFeeBps({ marketData, matcherCtxData, withUtilMax: true })!;
    const util = utilFeeMaxBpsOf(marketData);
    expect(first.feeBps).toBe(135n);
    expect(util).toBeGreaterThan(0);
    const want = 135n + BigInt(util);
    expect(raised.feeBps).toBe(want < raised.maxFeeBps ? want : raised.maxFeeBps);
    expect(raised.feeBps).toBeGreaterThan(first.feeBps);
    expect(raised.feeBps).toBeLessThanOrEqual(raised.maxFeeBps);
  });

  it("send: a 98 rebuilds ONCE with the raised cap and sends again; other errors pass through", async () => {
    const send = vi.fn(async (raised: boolean) => { if (!raised) throw e98(); return "SIG"; });
    expect(await sendWithUtilFeeRetry(send)).toBe("SIG");
    expect(send.mock.calls.map((c) => c[0])).toEqual([false, true]);
    const other = vi.fn(async () => { throw new Error("custom program error: 0x31"); });
    await expect(sendWithUtilFeeRetry(other)).rejects.toThrow(/0x31/);
    expect(other).toHaveBeenCalledTimes(1);
    expect(isUtilFeeNotCovered(new Error("custom program error: 0x62"))).toBe(true);
    expect(isUtilFeeNotCovered(new Error("custom program error: 0x31"))).toBe(false);
  });

  it("P-3b: 98 then the real refusal (49) shows the 49 once; 98 twice is 'Side too busy', never 'Try again' in a loop", async () => {
    const e49 = Object.assign(new Error('{"InstructionError":[3,{"Custom":49}]}'), { code: 49 });
    await expect(sendWithUtilFeeRetry(async (raised) => { throw raised ? e49 : e98(); })).rejects.toBe(e49);
    const twice = await sendWithUtilFeeRetry(async () => { throw e98(); }).catch((e) => e);
    expect(twice).toBeInstanceOf(UtilFeeOverMaxError);
    const m = resolveUserMessage(twice, { surface: "trade" });
    expect(m.kind).toBe("side-too-busy");
    expect(m.body).toBe("This side is too busy for an order this size right now. Try a smaller size or the other side. Nothing was sent.");
    expect(m.action).toBeUndefined();
  });

  it("both trade hooks send through the retry", () => {
    for (const f of ["hooks/useTrade.ts", "hooks/useFirstTrade.ts"]) expect(readFileSync(path.join(__dirname, "../../..", f), "utf8")).toContain("sendWithUtilFeeRetry(async (raised) =>");
  });
});
