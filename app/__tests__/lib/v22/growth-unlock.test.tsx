import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GrowthTicketPanel } from "@/components/trade/GrowthTicketPanel";
import { growthMarketView, growthTicketDecision, type GrowthMarketView } from "@/lib/v21/growth-market";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { V22_COPY } from "@/lib/v22/copy";
import { DEPTH_PREV_REAL, DEPTH_EVER, type AssetGrowthV19 } from "@/lib/v22/sdk/records/growth-v19";
import { NO_UNLOCK, compactUsd, growthUnlockView, unlockLine, waitLabel } from "@/lib/v22/growth-unlock";
import { ENGINE, marketRaw } from "../v21/fixtures";

// The fixtures are v2.1-layout markets: pin the v2.1 geometry whatever the suite-wide flag is. The v2.2 fields are laid over the record.
beforeEach(() => __setDevnetV22ForTest(false));
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

const NOW = 1_000_000n;
const BAND = 130;
const GAP = 397; // G(1.3%)
const USD = 1_000_000n;

interface Scenario {
  band?: number;
  gap?: number;
  launch?: number;
  tier?: number;
  ceil?: number;
  ceilSlot?: bigint;
  backingUsd?: bigint;
  hlock?: number;
  /** source 1 keeper-attested, 2 on-chain pool */
  depth?: { source?: number; usd?: bigint; prevUsd?: bigint; ageSlots?: bigint; ever?: boolean } | null;
  attestedMaxTier?: number;
  now?: bigint | null;
  /** Rate limiter: the last good (usable) depth and the epoch of its last rise. */
  lastGoodUsd?: bigint;
  /** Slots since the last rise of the usable depth (the 9,000-slot window is measured from it). */
  riseAgo?: bigint;
  /** Per-market leverage table L1..L3 x100. */
  table?: [number, number, number];
  /** Collateral decimals (default 6). */
  decimals?: number;
}

function scenario(s: Scenario = {}) {
  const dec = s.decimals ?? 6;
  const UNIT = 10n ** BigInt(dec);
  const launch = s.launch ?? 300;
  const raw = marketRaw({ launch, tier: s.tier ?? 1_000, ceil: s.ceil ?? launch, gap: s.gap ?? GAP }, s.hlock ?? 0);
  const base = growthMarketView({
    raw,
    engine: ENGINE,
    lp: { capital: (s.backingUsd ?? 100n) * UNIT, pnl: 0n, feeCredits: 0n },
    lpEffectiveQ: -10_000_000n,
    bound: true,
  })!;
  const d = s.depth === undefined ? null : s.depth;
  const record: AssetGrowthV19 = {
    ...base.record,
    ceilSlot: s.ceilSlot ?? NOW - 20_000n,
    attestedMaxTier: s.attestedMaxTier ?? 0,
    collateralDecimalsP1: dec + 1,
    collateralDecimals: dec,
    depthRiseSlot64: Number((NOW - (s.riseAgo ?? 0n)) / 64n),
    ...(s.table ? { tierLeverageX100: s.table } : {}),
    ...(d
      ? {
          depthSource: d.source ?? 1,
          depthEver: d.ever ?? true,
          depthPrevReal: true,
          depthE6: (d.usd ?? 0n) * UNIT,
          depthPrevE6: (d.prevUsd ?? d.usd ?? 0n) * UNIT,
          depthSlot: NOW - (d.ageSlots ?? 10n),
          depthLastGoodE6: (s.lastGoodUsd ?? d.usd ?? 0n) * UNIT,
          depthLastGoodSlot: NOW - (d.ageSlots ?? 10n),
        }
      : {}),
  };
  const view: GrowthMarketView = { ...base, record };
  return { view, input: { view, bandBps: s.band ?? BAND, nowSlot: s.now === undefined ? NOW : s.now } };
}
const run = (s: Scenario = {}) => growthUnlockView(scenario(s).input);
const line = (s: Scenario = {}, collateral?: Parameters<typeof unlockLine>[1]) => unlockLine(run(s).unlock, collateral);

describe("graduation on / off", () => {
  it("off-band market: no tier, no unlock line, no sticky line, nothing said", () => {
    expect(run({ band: 0, depth: { usd: 30_000n } })).toEqual(NO_UNLOCK);
    expect(line({ band: 0 })).toBeNull();
  });
  it("a band market whose stored r_gap is not the derived one is treated as off", () => {
    expect(run({ gap: 500 })).toEqual(NO_UNLOCK);
  });
  it("clock unknown: graduation on but no tier, unlock or sticky is claimed", () => {
    expect(run({ now: null })).toEqual({ graduation: true, tier: null, unlock: null, sticky: false });
  });
});

describe("the next-unlock line: both / depth / backing / ratchet", () => {
  it("both short: one line names both", () => {
    expect(line()).toBe("5x unlocks at $25k pool depth and $25k market backing");
  });
  it("only backing short", () => {
    expect(line({ depth: { usd: 30_000n } })).toBe("5x unlocks when market backing reaches $25k");
  });
  it("only pool depth short", () => {
    expect(line({ backingUsd: 30_000n })).toBe("5x unlocks when pool depth reaches $25k");
  });
  it("earned but not yet applied: the ratchet step with a time", () => {
    const earned = { depth: { usd: 30_000n }, backingUsd: 30_000n, ceil: 300 };
    expect(run(earned).tier).toBe(1);
    expect(line({ ...earned, ceilSlot: NOW - 100n })).toBe("Next step: 4x in about an hour");
    expect(line({ ...earned, ceilSlot: NOW - 8_000n })).toBe("Next step: 4x in about 7 minutes");
    expect(line({ ...earned, ceilSlot: NOW - 9_000n })).toBe("Next step: 4x at the next update");
  });
  it("the next tier needs a reading keeper-reported depth cannot give: nothing is promised", () => {
    expect(line({ depth: { usd: 30_000n }, backingUsd: 120_000n, ceil: 500 })).toBeNull();
  });
  it("with on-chain depth allowed (or a higher attested limit) the higher tier is named", () => {
    expect(line({ depth: { usd: 30_000n }, backingUsd: 120_000n, ceil: 500, attestedMaxTier: 3 })).toBe("10x unlocks when pool depth reaches $100k");
    expect(line({ depth: { source: 2, usd: 150_000n }, backingUsd: 30_000n, ceil: 500 })).toBe("10x unlocks when market backing reaches $100k");
    expect(line({ depth: { source: 2, usd: 30_000n }, backingUsd: 30_000n, ceil: 500 })).toBe("10x unlocks at $100k pool depth and $100k market backing");
  });
  it("nothing when at the market's own maximum or while the market recovers from a loss", () => {
    expect(line({ tier: 300, depth: { usd: 30_000n }, backingUsd: 30_000n })).toBeNull();
    expect(line({ hlock: 1 })).toBeNull();
  });
  it("never shows a raw bps / x100 number", () => {
    for (const s of [{}, { depth: { usd: 30_000n } }, { backingUsd: 30_000n }, { depth: { usd: 30_000n }, backingUsd: 30_000n }]) {
      expect(line(s) ?? "").not.toMatch(/bps|x100|\d{4,}/);
    }
  });
  it("label helpers", () => {
    expect([999, 25_000, 25_500, 100_000, 1_500_000, 2_000_000].map(compactUsd)).toEqual(["$999", "$25k", "$25.5k", "$100k", "$1.5M", "$2M"]);
    expect([1, 7, 27, 55, 60].map(waitLabel)).toEqual(["about a minute", "about 7 minutes", "about 27 minutes", "about an hour", "about an hour"]);
    expect(unlockLine(null)).toBeNull();
  });
});

describe("rate-limited depth: the pool is deep enough, the hourly doubling limit is the only wait", () => {
  // The pool reads $30k (tier 1 needs $25k) but the usable reading was $10k and rose in the current epoch: it can double once per hour.
  const caughtUp = { depth: { usd: 30_000n }, lastGoodUsd: 10_000n, riseAgo: 1_000n, backingUsd: 30_000n };
  it("usable depth is the slower of the two: tier stays 0 until it catches up", () => {
    expect(run(caughtUp).tier).toBe(0);
  });
  it("one calm line with the wait", () => {
    expect(line(caughtUp)).toBe("5x unlocks in about 2 hours as the pool reading catches up");
  });
  it("less than an hour away reads in minutes", () => {
    expect(line({ ...caughtUp, lastGoodUsd: 15_000n })).toBe("5x unlocks in about 54 minutes as the pool reading catches up");
  });
  it("already allowed to rise: it happens at the next update", () => {
    expect(line({ ...caughtUp, lastGoodUsd: 15_000n, riseAgo: 20_000n })).toBe("5x unlocks at the next update");
  });
  it("the window is 9,000 slots since the LAST RISE, not a calendar epoch: a rise 1 slot ago waits almost the full window", () => {
    // 20k -> 30k allowed 9,000 slots after the last rise (rounded up to its 64-slot stamp): about 60 minutes, not "next epoch boundary"
    expect(line({ ...caughtUp, lastGoodUsd: 15_000n, riseAgo: 1n })).toBe("5x unlocks in about an hour as the pool reading catches up");
  });
  it("with the backing also short, the backing is what is named", () => {
    expect(line({ ...caughtUp, backingUsd: 100n })).toBe("5x unlocks when market backing reaches $25k");
  });
  it("climb and catch-up both pending: the LATER wait is shown, one line", () => {
    // tier 1 earned (on-chain depth $30k), +1x climb pending, tier 2 needs $100k of depth: pool reads $150k but usable is $30k.
    const both = { depth: { source: 2, usd: 150_000n }, lastGoodUsd: 30_000n, riseAgo: 1_000n, backingUsd: 150_000n, ceil: 300, ceilSlot: NOW - 9_000n };
    expect(line(both)).toBe("10x unlocks in about 6 hours as the pool reading catches up"); // 1x per hour from 4x to 10x outlasts the ~2 h catch-up
  });
  it("climb and catch-up both pending, catch-up later: the catch-up wait is shown", () => {
    const both = { depth: { source: 2, usd: 150_000n }, lastGoodUsd: 30_000n, riseAgo: 1_000n, backingUsd: 150_000n, ceil: 500, ceilSlot: NOW - 9_000n, table: [600, 700, 0] as [number, number, number] };
    // stored 5x, tier-1 target 6x: one step; tier 2 is 7x: climb about 1-2 h total, catch-up about 2 h
    expect(line(both)).toBe("7x unlocks in about 2 hours as the pool reading catches up");
  });
  it("a keeper-only market that can never reach the tier says nothing, rate limit or not", () => {
    expect(line({ depth: { usd: 150_000n }, lastGoodUsd: 30_000n, riseAgo: 1_000n, backingUsd: 150_000n, ceil: 500 })).toBeNull();
  });
});

describe("collateral wording: $ only on 6-decimal USD-like collateral", () => {
  it("test USDC: dollars", () => {
    expect(line({ backingUsd: 30_000n }, { decimals: 6, symbol: "USDC", usdLike: true })).toBe("5x unlocks when pool depth reaches $25k");
  });
  it("another token: named by its symbol, never a dollar sign", () => {
    expect(line({ backingUsd: 30_000n, decimals: 9 }, { decimals: 9, symbol: "TOK", usdLike: false })).toBe("5x unlocks when pool depth reaches 25k TOK");
    expect(line({ depth: { usd: 30_000n }, decimals: 9 }, { decimals: 9, symbol: "TOK", usdLike: false })).toBe("5x unlocks when market backing reaches 25k TOK");
  });
  it("a USD-like token with other decimals is not dollars either", () => {
    expect(line({ backingUsd: 30_000n, decimals: 9 }, { decimals: 9, symbol: "USDX", usdLike: true })).toBe("5x unlocks when pool depth reaches 25k USDX");
  });
  it("the tiers read the market's own decimals: 9-decimal collateral reaches tier 1 at 25k tokens", () => {
    expect(run({ depth: { usd: 30_000n }, backingUsd: 30_000n, decimals: 9 }).tier).toBe(1);
  });
});

describe("tier = the lower of pool depth and market backing", () => {
  it("badge value", () => {
    expect(run({ depth: { usd: 30_000n }, backingUsd: 100n }).tier).toBe(0);
    expect(run({ depth: { usd: 5_000n }, backingUsd: 30_000n }).tier).toBe(0);
    expect(run({ depth: { usd: 30_000n }, backingUsd: 30_000n }).tier).toBe(1);
    expect(run({ depth: { source: 2, usd: 150_000n }, backingUsd: 30_000n }).tier).toBe(1);
    expect(run({ depth: { source: 2, usd: 150_000n }, backingUsd: 150_000n }).tier).toBe(2);
    expect(run({ depth: { source: 2, usd: 900_000n }, backingUsd: 900_000n }).tier).toBe(3);
  });
  it("keeper-reported depth is capped at tier 1 by default", () => {
    expect(run({ depth: { usd: 900_000n }, backingUsd: 900_000n }).tier).toBe(1);
  });
  it("stale depth reads tier 0, and so does a one-push spike (min of the last two readings)", () => {
    expect(run({ depth: { usd: 30_000n, ageSlots: 151n }, backingUsd: 30_000n }).tier).toBe(0);
    expect(run({ depth: { usd: 30_000n, ageSlots: 150n }, backingUsd: 30_000n }).tier).toBe(1);
    expect(run({ depth: { usd: 30_000n, prevUsd: 10_000n }, backingUsd: 30_000n }).tier).toBe(0);
  });
});

describe("sticky: a depth reading was seen and has stopped", () => {
  it("stale after having had it: sticky", () => {
    expect(run({ depth: { usd: 30_000n, ageSlots: 400n } }).sticky).toBe(true);
  });
  it("fresh: not sticky", () => {
    expect(run({ depth: { usd: 30_000n } }).sticky).toBe(false);
  });
  it("never had one: not sticky (nothing to be out of date)", () => {
    expect(run({}).sticky).toBe(false);
    expect(run({ depth: { usd: 30_000n, ageSlots: 400n, ever: false } }).sticky).toBe(false);
  });
  it("a fresh real zero is a full side, not 'out of date'", () => {
    expect(run({ depth: { usd: 0n, prevUsd: 30_000n } }).sticky).toBe(false);
  });
  it("band flag byte constants agree with the program", () => {
    expect(DEPTH_PREV_REAL).toBe(0x04);
    expect(DEPTH_EVER).toBe(0x80);
  });
});

describe("GrowthTicketPanel: max line, tier badge, unlock and sticky lines", () => {
  const draw = (s: Scenario, withUnlock = true) => {
    const { view, input } = scenario(s);
    render(
      <GrowthTicketPanel
        view={view}
        decision={growthTicketDecision(view, "long", 0n, 1_000_000n)}
        direction="long"
        unlock={withUnlock ? growthUnlockView(input) : null}
      />,
    );
  };
  it("graduation on: 'Max leverage now' per side, tier badge, one unlock line", () => {
    draw({});
    expect(screen.getByTestId("growth-max-now")).toHaveTextContent(/^Max leverage now: .*x long · .*x short$/);
    expect(screen.getByTestId("growth-tier")).toHaveTextContent("Liquidity tier 0");
    expect(screen.getByTestId("growth-unlock")).toHaveTextContent("5x unlocks at $25k pool depth and $25k market backing");
    expect(screen.getByTestId("growth-adjusts")).toHaveTextContent("Leverage adjusts with market backing.");
    expect(screen.queryByTestId("growth-sticky")).toBeNull();
  });
  it("tier badge follows the lower of depth and backing", () => {
    draw({ depth: { usd: 30_000n }, backingUsd: 30_000n });
    expect(screen.getByTestId("growth-tier")).toHaveTextContent("Liquidity tier 1");
  });
  it("the tooltip names both inputs in one sentence", () => {
    expect(V22_COPY.growth.tierTip).toBe(
      "Liquidity tier is the lower of two things, how much trading depth the token's pool has near the price and how much money backs this market; higher tiers allow more leverage.",
    );
    expect(V22_COPY.growth.tierTip.split(". ").length).toBe(1);
    expect(V22_COPY.growth.tierTip).toMatch(/depth/);
    expect(V22_COPY.growth.tierTip).toMatch(/backs this market/);
  });
  it("sticky: one calm line, closes stay open", () => {
    draw({ depth: { usd: 30_000n, ageSlots: 400n } });
    expect(screen.getByTestId("growth-sticky")).toHaveTextContent("Liquidity reading is out of date — new positions are limited until it updates. Closes are open.");
  });
  it("off-band market: no badge, no unlock, no sticky line, the max line is unchanged", () => {
    draw({ band: 0, depth: { usd: 30_000n, ageSlots: 400n } });
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    expect(screen.queryByTestId("growth-unlock")).toBeNull();
    expect(screen.queryByTestId("growth-sticky")).toBeNull();
    expect(screen.getByTestId("growth-max-now")).toBeInTheDocument();
  });
  it("no unlock prop (flag off / not a growth ticket): same as before", () => {
    draw({}, false);
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    expect(screen.queryByTestId("growth-unlock")).toBeNull();
  });
  it("copy never claims 'up to 10x' on its own or shows raw numbers", () => {
    draw({ depth: { usd: 30_000n } });
    expect(screen.getByTestId("growth-ticket-panel").textContent).not.toMatch(/up to \d+x|bps|x100/i);
  });
});
