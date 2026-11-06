/**
 * Council GO1106-UX #4 (Creator, HIGH): "Pasting mainnet USDC (EPjFWdd5…) into the create wizard passes the token step.
 * Step 2 then shows MARKET 'USDC', PRICE FEED 'Keeper: PUMP / USDC (PumpSwap)' and START PRICE $0.003969, which is
 * PUMP's price. 'Hold to launch' is enabled." DexScreener lists a pair under BOTH of its tokens; priceUsd is the base's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { dexPairBaseIs, dexPairQuoteIs, QUOTE_ONLY_REASON } from "@/lib/dex-pair-side";
import { useDexPoolSearch } from "@/hooks/useDexPoolSearch";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const PUMP_POOL = "2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd";
const pumpUsdc = {
  chainId: "solana", dexId: "pumpswap", pairAddress: PUMP_POOL,
  baseToken: { address: PUMP, symbol: "PUMP" }, quoteToken: { address: USDC, symbol: "USDC" },
  liquidity: { usd: 5_000_000 }, priceUsd: "0.003969",
};

describe("dexPairBaseIs / dexPairQuoteIs", () => {
  it("PUMP/USDC prices PUMP, not USDC", () => {
    expect(dexPairBaseIs(pumpUsdc, PUMP)).toBe(true);
    expect(dexPairBaseIs(pumpUsdc, USDC)).toBe(false);
    expect(dexPairQuoteIs(pumpUsdc, USDC)).toBe(true);
    expect(dexPairQuoteIs(pumpUsdc, PUMP)).toBe(false);
  });
  it("a pair with no base address is never taken as pricing the mint", () => {
    expect(dexPairBaseIs({ baseToken: { address: undefined } }, USDC)).toBe(false);
  });
});

describe("useDexPoolSearch: a mint on the quote side only", () => {
  let classified: string[] = [];
  beforeEach(() => {
    classified = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("dexscreener")) return new Response(JSON.stringify({ pairs: [pumpUsdc] }), { status: 200 });
      if (url === "/api/dex/classify-pools") {
        const { addresses } = JSON.parse(String(init?.body)) as { addresses: string[] };
        classified.push(...addresses);
        return new Response(JSON.stringify({ classes: Object.fromEntries(addresses.map((a) => [a, "pumpswap"])) }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("USDC: no pool is offered (was PUMP/USDC at $0.003969) and the reason says why", async () => {
    const { result } = renderHook(() => useDexPoolSearch(USDC));
    await waitFor(() => expect(result.current.blockedReason).not.toBeNull());
    expect(result.current.pools).toEqual([]);
    expect(result.current.blockedReason).toBe(QUOTE_ONLY_REASON);
    expect(classified).toEqual([]);
  });
  it("CONTROL PUMP: the same pool is offered for its base token", async () => {
    const { result } = renderHook(() => useDexPoolSearch(PUMP));
    await waitFor(() => expect(result.current.pools.length).toBe(1));
    expect(result.current.pools[0].priceUsd).toBeCloseTo(0.003969, 6);
  });
});
