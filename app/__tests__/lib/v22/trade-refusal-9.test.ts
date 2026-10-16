/**
 * Q-1 / Q-6 (v2.2 QA 2026-10-11): a trade refused Custom(9) names the cause the chain proves, never the
 * old "usually slippage" guess; a 5th asset is blocked up front. Real SOL market + matcher bytes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import fixture from "../../fixtures/v22-fee-channel-2026-10-11.json";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { decodeMarketEngineView, decodeMatcherCtx } from "@/lib/limits/decode";
import { preTradeQuote } from "@/lib/limits/matcher-quote";
import { humanizeError } from "@/lib/errorMessages";
import {
  classifyV22Custom9,
  diagnoseV22TradeCustom9,
  positionCapBlocksOpen,
  V22_CUSTOM9_COPY,
  V22_CUSTOM9_GENERIC,
  V22_POSITION_CAP_COPY,
} from "@/lib/v22/trade-refusal-9";

const SOL = (fixture.markets as Record<string, { market: string; matcherCtx: string; marketB64: string; matcherCtxB64: string }>).SOL;
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const RAW_9 =
  'Simulation failed. Error: {"InstructionError":[2,{"Custom":9}]} Program 6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM failed: custom program error: 0x9';

describe("Q-6 position cap", () => {
  it("4 distinct assets held, a new one => blocked", () => {
    expect(positionCapBlocksOpen([0, 1, 2, 3], 4)).toBe(true);
    expect(V22_POSITION_CAP_COPY.startsWith("This account already holds ")).toBe(true);
  });
  it("NEGATIVE CONTROLS: adding to a held asset, or 3 held, is not blocked", () => {
    expect(positionCapBlocksOpen([0, 1, 2, 3], 2)).toBe(false);
    expect(positionCapBlocksOpen([0, 1, 2], 3)).toBe(false);
    expect(positionCapBlocksOpen([], 0)).toBe(false);
  });
});

describe("Q-1 Custom(9) classification", () => {
  const base = { heldAssets: [] as number[], assetIndex: 0, quotePriceE6: 100_500_000n, takerBuys: true };
  it("quote above a long's limit => price-limit", () => {
    expect(classifyV22Custom9({ ...base, limitPriceE6: 100_400_000n })).toBe("price-limit");
  });
  it("quote below a short's limit => price-limit", () => {
    expect(classifyV22Custom9({ ...base, takerBuys: false, quotePriceE6: 99_000_000n, limitPriceE6: 99_100_000n })).toBe("price-limit");
  });
  it("5th asset => position-cap (checked first)", () => {
    expect(classifyV22Custom9({ ...base, heldAssets: [1, 2, 3, 4], limitPriceE6: 100_400_000n })).toBe("position-cap");
  });
  it("signed fee below what the chain needs => fee-cap", () => {
    expect(classifyV22Custom9({ ...base, limitPriceE6: 200_000_000n, signedFeeBps: 30n, neededFeeBps: 53n })).toBe("fee-cap");
  });
  it("NEGATIVE CONTROL: quote inside the limit, no cap, fee covered => undetermined (no slippage claim)", () => {
    expect(classifyV22Custom9({ ...base, limitPriceE6: 101_000_000n, signedFeeBps: 63n, neededFeeBps: 53n })).toBe("undetermined");
    expect(V22_CUSTOM9_COPY.undetermined).not.toMatch(/slippage/i);
  });
});

describe("diagnoseV22TradeCustom9 on the real SOL bytes", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterEach(() => __setDevnetV22ForTest(null));
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => {
        const b64 = k.toBase58() === SOL.market ? SOL.marketB64 : k.toBase58() === SOL.matcherCtx ? SOL.matcherCtxB64 : null;
        return b64 ? { data: Buffer.from(b64, "base64"), executable: false, lamports: 1, owner: PublicKey.default } : null;
      }),
  };
  const solQuote = () => {
    const e = decodeMarketEngineView(bytes(SOL.marketB64))!;
    return preTradeQuote(decodeMatcherCtx(bytes(SOL.matcherCtxB64))!, e.effectivePriceE6, 1_000_000n, true)!.quotePriceE6!;
  };

  it("a long whose limit is below the matcher's quote => the price-limit line", async () => {
    const msg = await diagnoseV22TradeCustom9(conn, { market: new PublicKey(SOL.market), matcherCtx: new PublicKey(SOL.matcherCtx), sizeQ: 1_000_000n, limitPriceE6: solQuote() - 1n });
    expect(msg).toBe(V22_CUSTOM9_COPY["price-limit"]);
  });
  it("NEGATIVE CONTROL: a limit that covers the quote => the honest generic line", async () => {
    const msg = await diagnoseV22TradeCustom9(conn, { market: new PublicKey(SOL.market), matcherCtx: new PublicKey(SOL.matcherCtx), sizeQ: 1_000_000n, limitPriceE6: solQuote() + 1n });
    expect(msg).toBe(V22_CUSTOM9_GENERIC);
  });
  it("RPC failure never throws", async () => {
    const bad = { getMultipleAccountsInfo: async () => { throw new Error("429"); } };
    expect(await diagnoseV22TradeCustom9(bad, { market: new PublicKey(SOL.market), sizeQ: 1n })).toBe(V22_CUSTOM9_GENERIC);
  });
});

describe("humanizeError trade-context Custom(9)", () => {
  afterEach(() => __setDevnetV22ForTest(null));
  it("flag on: no slippage guess, no 'invalid instruction' jargon", () => {
    __setDevnetV22ForTest(true);
    const m = humanizeError(RAW_9, "trade");
    expect(m).toBe(V22_CUSTOM9_GENERIC);
  });
  it("NEGATIVE CONTROL flag off: the legacy line is unchanged", () => {
    __setDevnetV22ForTest(false);
    expect(humanizeError(RAW_9, "trade")).toMatch(/slippage tolerance/);
  });
});
