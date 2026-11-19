// @vitest-environment node
/**
 * UX WP-4 (audit §3.6, user decisions 2026-09-30): the Earn withdrawal flow, the worse-of
 * pricing every preview uses during a price catch-up, and max_now (88 before it happens).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cooldownPhrase,
  fmtCountdown,
  capMaxNowToPosition,
  maxNowAtoms,
  previewWithdrawAtoms,
  sharesForUsdc,
  withdrawFlow,
} from "@/lib/limits/earn-withdraw";
import { earnPanelPricing } from "@/lib/limits/earn";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { A_EFFECTIVE_PRICE, A_RAW_ORACLE_TARGET_PRICE } from "@/lib/limits/constants";
import { marketLimits } from "./fixtures";

describe("the flow: two steps unless the vault's cooldown is 0", () => {
  it("cooldown 0 => one tx [76, 77]; any cooldown => request, then the payout", () => {
    expect(withdrawFlow(0n)).toBe("one-tx");
    expect(withdrawFlow(20n)).toBe("two-step");
    expect(withdrawFlow(150n)).toBe("two-step");
  });
  it("plain time: ~150 slots is 'about a minute'; the countdown is m:ss", () => {
    expect(cooldownPhrase(150n)).toBe("about a minute");
    expect(cooldownPhrase(20n)).toBe("a few seconds");
    expect(cooldownPhrase(1_500n)).toBe("about 10 minutes");
    expect(fmtCountdown(60_000)).toBe("1:00");
    expect(fmtCountdown(7_200)).toBe("0:08");
    expect(fmtCountdown(-5)).toBe("0:00");
  });
});

describe("the panel's pricing = the wrapper's worse-of rule (earn-pricing.ts, ede691b6)", () => {
  const short400 = () => ({ ...marketLimits().lp!, legs: [{ slot: 0, assetIndex: 0, side: 1, basisPosQ: -400_000_000n }] });
  it("a SHORT vault LP facing a pending +$0.10: the exit is priced at target, the entry is unchanged (no draw)", () => {
    const base = marketLimits();
    // certified equity 120; at target the short loses 40 => worse 80 (>= 0): the junior absorbs it
    const L = marketLimits({ lp: short400(), engine: { ...base.engine!, targetPriceE6: 1_100_000n } as never });
    const L0 = marketLimits({ lp: short400(), engine: { ...base.engine!, targetPriceE6: 1_000_000n } as never });
    const backing = 800_000_000n; // + 2 harvestable = nav 802 < C_eff 1,002: the LP is valued
    const pr = earnPanelPricing(L, backing)!;
    const p0 = earnPanelPricing(L0, backing)!;
    expect(pr.depositSeniorValue).toBe(p0.depositSeniorValue); // 75 unchanged without a draw outstanding
    // nav < C: the LP counts at min(value, max(worse, 0)) = 80 instead of 120
    expect(p0.withdrawSeniorValue! - pr.withdrawSeniorValue!).toBe(40_000_000n);
  });
  it("a move past the junior (worse < 0) comes off the claim itself", () => {
    const base = marketLimits();
    const lpx = { ...short400(), cert: { ...base.lp!.cert, certifiedEquity: 20_000_000n } };
    const L = marketLimits({ lp: lpx, engine: { ...base.engine!, targetPriceE6: 1_100_000n } as never });
    const pr = earnPanelPricing(L, 1_000_000_000n)!; // + 2 harvestable: pots cover C_eff exactly (no junior surplus)
    expect(pr.withdrawSeniorValue).toBe(1_002_000_000n - 20_000_000n);
  });
});

describe("USDC <-> shares at the program's price", () => {
  it("sharesForUsdc floors, never exceeds the held shares; the preview redeems ≤ the typed USDC", () => {
    const total = 1_000_000_000n;
    const senior = 1_050_000_000n; // 1.05 per share
    const s = sharesForUsdc(10_000_000n, total, senior, 5_000_000_000n)!;
    expect(s).toBe(9_523_809n);
    expect(previewWithdrawAtoms(s, total, senior)!).toBeLessThanOrEqual(10_000_000n);
    expect(sharesForUsdc(10_000_000_000n, total, senior, 7n)).toBe(7n);
    expect(sharesForUsdc(10n, total, null, 7n)).toBeNull();
  });
});

describe("max_now: what the vault can pay out before open trades close", () => {
  const base = {
    valuation: "certified" as const, excludesUncrankedFees: false, harvestable: 0n, seniorClaimEff: 1_000_000_000n,
    backingCover: 600_000_000n, vaultValue: 1_100_000_000n, senior: 1_000_000_000n, junior: 100_000_000n, sharePriceE6: 1_000_000n,
    cushionBps: 1000, impaired: false, illiquid: true, juniorFloorAtoms: 100_000_000n, withdrawAtoms: null, withdrawKind: "illiquid" as const,
  };
  it("pots + a recall capped at the LP's value", () => {
    expect(maxNowAtoms(base, 500_000_000n, false)).toBe(1_000_000_000n); // recall 400 fits
    expect(maxNowAtoms(base, 150_000_000n, false)).toBe(750_000_000n); // the LP only holds 150
  });
  it("no recall while a senior draw is pending (D-P3-30); no cap when the pots cover", () => {
    expect(maxNowAtoms(base, 500_000_000n, true)).toBe(600_000_000n);
    expect(maxNowAtoms({ ...base, illiquid: false }, 500_000_000n, false)).toBeNull();
    expect(maxNowAtoms(null, 1n, false)).toBeNull();
  });
  it("is never more than the user's own position value (backingCover 1,000 vs a 10 position)", () => {
    const v = { ...base, backingCover: 1_000_000_000n, seniorClaimEff: 1_000_000_000n, vaultValue: 1_000_000_000n };
    expect(maxNowAtoms(v, 0n, false, 10_000_000n)).toBe(10_000_000n);
    expect(maxNowAtoms(v, 0n, false, 2_000_000_000n)).toBe(1_000_000_000n); // a bigger position doesn't raise it
    expect(capMaxNowToPosition(1_000_000_000n, 10_000_000n)).toBe(10_000_000n);
    expect(capMaxNowToPosition(null, 10_000_000n)).toBeNull();
  });
});

describe("the target price offset (engine AssetStateV16Account, packed Pod)", () => {
  it("raw_oracle_target_price sits 8 bytes before effective_price (market_id 8 + retired_slot 8 + lifecycle 1)", () => {
    expect(A_RAW_ORACLE_TARGET_PRICE).toBe(17);
    expect(A_EFFECTIVE_PRICE - A_RAW_ORACLE_TARGET_PRICE).toBe(8);
  });
  it("on a live market image, target and effective are the same order of magnitude", () => {
    const fx = JSON.parse(readFileSync(join(process.cwd(), "__tests__/fixtures/CdN8r7FB.freshness.market.json"), "utf8")) as { dataBase64: string };
    const v = decodeMarketEngineView(new Uint8Array(Buffer.from(fx.dataBase64, "base64")))!;
    expect(v.effectivePriceE6).toBeGreaterThan(0n);
    expect(v.targetPriceE6).toBeGreaterThan(0n);
    const r = Number(v.targetPriceE6) / Number(v.effectivePriceE6);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(2);
  });
});
