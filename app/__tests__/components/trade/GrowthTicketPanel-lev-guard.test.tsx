/**
 * App bug 2026-10-29: a guarded market in its first 6 hours (or with its guard missing) closes every open. The ticket's growth panel
 * said "This side of the market is full for now", which is not why; it now says what the program checks, with the unlock time.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { GrowthTicketPanel } from "@/components/trade/GrowthTicketPanel";
import { __setRc23OpenLimitsForTest, growthMarketView, growthTicketDecision } from "@/lib/v21/growth-market";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ASSET_GROWTH_FIELD_OFF } from "@/lib/v22/sdk/records/growth-v19";
import type { LevGuardV22 } from "@/lib/v22/sdk";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { marketRaw } from "../../lib/v21/fixtures";

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __setRc23OpenLimitsForTest(true);
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
  __setRc23OpenLimitsForTest(null);
});

const T0 = 1_000_000n;
const guard = { market: new PublicKey(new Uint8Array(32).fill(9)), t0Slot: T0, assetIndex: 0, flags: 0, mintAuthLive: false, freezeAuthLive: false, roundActive: false, roundOpenSlot: 0n,
  repJDumpBps: 0, repMIndBps: 0, repLCapX100: 0, repNMultBps: 0, repSlot: 0n, holderDumpBps: 0, holderDumpSlot: 0n, pbLastPx: 0n, pbLastSlot: 0n, pbRefPx: 0n, pbRefSlot: 0n,
  pbFreezeUntil: 0n, pbOracleUntil: 0n, frozenLX100: 0, frozenNQ: 0n, burstVarPeakX100: 0, burstPeakSlot: 0n } as unknown as LevGuardV22;

function view(account: LevGuardV22 | null, now: bigint) {
  const raw = marketRaw({ launch: 500, tier: 1_000, ceil: 500, lambda: 10_000 });
  const M = marketOffsets(raw);
  raw[M.wrapperOff(0) + M.layout.wrapperSlot.growth + ASSET_GROWTH_FIELD_OFF.flags] |= 0x04;
  return growthMarketView({
    raw,
    engine: { initialMarginBps: 1_000n, maintenanceMarginBps: 500n, effectivePriceE6: 1_000_000n, oiEffLongQ: 0n, oiEffShortQ: 0n, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n },
    lp: { capital: 50_000_000_000n, pnl: 0n, feeCredits: 0n },
    lpEffectiveQ: 0n,
    bound: true,
    guard: { account, mainnet: false },
    v22: { bandBps: 0, nowSlot: now },
  })!;
}

describe("GrowthTicketPanel: the guard's closed line", () => {
  it("first 6 hours: 'New market … unlocks in about 5 h', not 'full'", () => {
    const v = view(guard, T0 + 9_000n);
    render(<GrowthTicketPanel view={v} decision={growthTicketDecision(v, "long", 0n, 0n)} direction="long" />);
    const line = screen.getByTestId("growth-closed").textContent!;
    expect(line).toBe("New market: opening positions unlocks in about 5 h, 6 hours after this market launched. You can still close.");
    expect(line).not.toMatch(/full/);
  });
  it("guard missing: says so", () => {
    const v = view(null, T0 + 10n * 216_000n);
    render(<GrowthTicketPanel view={v} decision={growthTicketDecision(v, "short", 0n, 0n)} direction="short" />);
    expect(screen.getByTestId("growth-closed").textContent).toMatch(/safety guard isn't set up yet/);
  });
});
