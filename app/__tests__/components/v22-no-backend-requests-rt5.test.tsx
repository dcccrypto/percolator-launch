// @vitest-environment happy-dom
/**
 * v2.2 QA RT5-3: the v2.2 preview has no indexer / registry / warmup backend. These four screens used to ask anyway
 * (404 /api/candles, 404 /api/markets/:slab/trades, 501 /api/warmup, 503 /api/funding/global). On v2.2 they do not
 * ask. NEGATIVE CONTROL in each case: with the flag off the request is made exactly as before.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, waitFor } from "@testing-library/react";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { usePerpHeaderStats } from "@/hooks/usePerpHeaderStats";
import { TradeHistory } from "@/components/trade/TradeHistory";
import { FundingRates } from "@/components/dashboard/FundingRates";
import { WarmupProgress } from "@/components/trade/WarmupProgress";

const SLAB = "6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF";
let urls: string[] = [];
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("RT5-3: no backend requests on the v2.2 preview", () => {
  beforeEach(() => {
    urls = [];
    vi.stubGlobal("fetch", vi.fn(async (u: unknown) => { urls.push(String(u)); return new Response("{}", { status: 404 }); }));
  });
  afterEach(() => { __setDevnetV22ForTest(null); vi.unstubAllGlobals(); });

  const cases: Array<[string, RegExp, () => void]> = [
    ["header stats, 'last' series", /^\/api\/candles\//, () => { renderHook(() => usePerpHeaderStats(SLAB, 1, "last")); }],
    ["market trade tape", /^\/api\/markets\/.+\/trades/, () => { render(<TradeHistory slabAddress={SLAB} />); }],
    ["dashboard funding rates", /^\/api\/funding\/global/, () => { render(<FundingRates />); }],
    ["position warmup", /^\/api\/warmup\//, () => { render(<WarmupProgress slabAddress={SLAB} accountIdx={0} />); }],
  ];
  for (const [name, re, mount] of cases) {
    it(`${name}: not requested on v2.2`, async () => {
      __setDevnetV22ForTest(true);
      mount();
      await settle();
      expect(urls.filter((u) => re.test(u))).toEqual([]);
    });
    it(`${name}: NEGATIVE CONTROL, requested when the flag is off`, async () => {
      __setDevnetV22ForTest(false);
      mount();
      await waitFor(() => expect(urls.some((u) => re.test(u))).toBe(true));
    });
  }
});
