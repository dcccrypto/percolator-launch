// @vitest-environment node
/** lib/bot-api/builders/caps.ts: slippage, explicit-limit band, notional, leverage, reduce-only; reducing orders skip the size caps. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const risk = vi.hoisted(() => ({ v: { capital: 1_000_000_000n, pnl: 0n, feeCredits: 0n } as null | { capital: bigint; pnl: bigint; feeCredits: bigint }, maxLev: 20 as number | null }));
vi.mock("@/lib/limits/decode", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/decode")>()),
  decodePortfolioRisk: () => risk.v,
}));
vi.mock("@/lib/slab-max-leverage", () => ({ maxLeverageFromSlab: () => risk.maxLev }));

import { checkOrderCaps, resolveCaps, DEFAULT_SLIPPAGE_BPS } from "@/lib/bot-api/builders/caps";
import type { TradePreflight } from "@/lib/v22/trade-build";
import { ApiError } from "@/lib/bot-api/errors";

const PX = 2_000_000n; // 2.00 per q-unit (E6)
const pf = (o: Partial<TradePreflight> = {}): TradePreflight => ({
  size: 1_000_000_000n, // 1e9 q x 2.0 = 2,000 USD notional
  limitPriceE6: PX + PX / 100n,
  effectivePriceE6: PX,
  positionBeforeQ: 0n,
  reducing: false,
  marketData: new Uint8Array(0),
  portfolioData: new Uint8Array(1),
  ...o,
});
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return (e as ApiError).code;
  }
  return "ok";
};
const caps = (o: Parameters<typeof resolveCaps>[0] = { explicitLimit: false }) => resolveCaps(o);

beforeEach(() => {
  risk.v = { capital: 1_000_000_000n, pnl: 0n, feeCredits: 0n }; // 1,000 USD equity
  risk.maxLev = 20;
});
afterEach(() => vi.unstubAllEnvs());

describe("resolveCaps", () => {
  it("defaults: 100 bps, 5,000 USD, 10x; caller can only tighten; slippage over 1000 refused", () => {
    expect(caps()).toMatchObject({ slippageBps: DEFAULT_SLIPPAGE_BPS, maxNotionalUsd: 5000, maxLeverage: 10, reduceOnly: false });
    expect(caps({ explicitLimit: false, maxNotionalUsd: 1e9, maxLeverage: 50 })).toMatchObject({ maxNotionalUsd: 5000, maxLeverage: 10 });
    expect(caps({ explicitLimit: false, maxNotionalUsd: 100, maxLeverage: 2 })).toMatchObject({ maxNotionalUsd: 100, maxLeverage: 2 });
    expect(code(() => caps({ explicitLimit: false, slippageBps: 1001 }))).toBe("slippage_cap_exceeded");
  });
  it("server caps come from env", () => {
    vi.stubEnv("BOT_API_MAX_NOTIONAL_USD", "250");
    vi.stubEnv("BOT_API_MAX_LEVERAGE", "3");
    expect(caps()).toMatchObject({ maxNotionalUsd: 250, maxLeverage: 3 });
  });
});

describe("checkOrderCaps", () => {
  it("passes a 2,000 USD 2x open and reports the numbers", () => {
    const r = checkOrderCaps(caps(), pf());
    expect(r.notionalUsd).toBe(2000);
    expect(r.leverageAfter).toBe(2);
  });
  it("refuses notional over the cap", () => {
    expect(code(() => checkOrderCaps(caps({ explicitLimit: false, maxNotionalUsd: 1999 }), pf()))).toBe("notional_cap_exceeded");
    expect(code(() => checkOrderCaps(caps(), pf({ size: 3_000_000_000n })))).toBe("notional_cap_exceeded");
  });
  it("refuses leverage after the order over min(caller, market, server)", () => {
    // 4,000 USD on 1,000 equity = 4x
    expect(code(() => checkOrderCaps(caps({ explicitLimit: false, maxLeverage: 3.99 }), pf({ size: 2_000_000_000n })))).toBe("leverage_cap_exceeded");
    expect(code(() => checkOrderCaps(caps({ explicitLimit: false, maxLeverage: 4 }), pf({ size: 2_000_000_000n })))).toBe("ok");
    risk.maxLev = 3;
    expect(code(() => checkOrderCaps(caps(), pf({ size: 2_000_000_000n })))).toBe("leverage_cap_exceeded");
  });
  it("counts the existing position and only negative pnl / fee credits in equity", () => {
    // existing 1e9 long + 1e9 buy = 4,000 USD; equity 1,000 - 300 = 700 -> 5.7x
    risk.v = { capital: 1_000_000_000n, pnl: -300_000_000n, feeCredits: 0n };
    expect(code(() => checkOrderCaps(caps({ explicitLimit: false, maxLeverage: 5 }), pf({ positionBeforeQ: 1_000_000_000n })))).toBe("leverage_cap_exceeded");
    risk.v = { capital: 1_000_000_000n, pnl: 5_000_000_000n, feeCredits: 0n };
    expect(code(() => checkOrderCaps(caps({ explicitLimit: false, maxLeverage: 5 }), pf({ positionBeforeQ: 1_000_000_000n })))).toBe("ok");
    risk.v = { capital: 0n, pnl: 0n, feeCredits: 0n };
    expect(code(() => checkOrderCaps(caps(), pf()))).toBe("insufficient_margin");
  });
  it("reduce-only: refuses growth, a flip, no position; a reducing order skips notional and leverage", () => {
    const ro = caps({ explicitLimit: false, reduceOnly: true, maxNotionalUsd: 1 });
    expect(code(() => checkOrderCaps(ro, pf({ positionBeforeQ: 5n, reducing: false })))).toBe("reduce_only_violation");
    expect(code(() => checkOrderCaps(ro, pf({ positionBeforeQ: 0n, reducing: false })))).toBe("no_position");
    expect(code(() => checkOrderCaps(ro, pf({ positionBeforeQ: null, reducing: false })))).toBe("market_unreadable");
    expect(code(() => checkOrderCaps(ro, pf({ positionBeforeQ: 9_000_000_000n, size: -9_000_000_000n, reducing: true })))).toBe("ok");
  });
  it("an explicit limit more than 1000 bps on the adverse side is refused, a better one is fine", () => {
    const ex = caps({ explicitLimit: true });
    expect(code(() => checkOrderCaps(ex, pf({ limitPriceE6: PX + (PX * 1001n) / 10_000n })))).toBe("slippage_cap_exceeded");
    expect(code(() => checkOrderCaps(ex, pf({ limitPriceE6: PX + PX / 10n })))).toBe("ok");
    expect(code(() => checkOrderCaps(ex, pf({ size: -1_000_000_000n, limitPriceE6: PX - (PX * 1001n) / 10_000n })))).toBe("slippage_cap_exceeded");
    expect(code(() => checkOrderCaps(ex, pf({ size: -1_000_000_000n, limitPriceE6: PX * 2n })))).toBe("ok");
  });
  it("an unreadable price or account refuses instead of skipping the check", () => {
    expect(code(() => checkOrderCaps(caps(), pf({ effectivePriceE6: 0n })))).toBe("market_unreadable");
    risk.v = null;
    expect(code(() => checkOrderCaps(caps(), pf()))).toBe("market_unreadable");
  });
});
