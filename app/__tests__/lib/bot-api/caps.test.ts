// @vitest-environment node
/** lib/bot-api/builders/caps.ts: slippage, explicit-limit band, notional, leverage, reduce-only; reducing orders skip the size caps. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const risk = vi.hoisted(() => ({ v: { capital: 1_000_000_000n, pnl: 0n, feeCredits: 0n } as null | { capital: bigint; pnl: bigint; feeCredits: bigint }, maxLev: 20 as number | null }));
vi.mock("@/lib/limits/decode", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/decode")>()),
  decodePortfolioRisk: () => risk.v,
}));
vi.mock("@/lib/slab-max-leverage", () => ({ maxLeverageFromSlab: () => risk.maxLev }));
// Value-side PnL of the open leg (reads/account.ts openLegsValuePnl): flat by default, set per test.
const leg = vi.hoisted(() => ({ v: { kind: "flat" } as { kind: "flat" } | { kind: "open"; valuePnl: bigint } | { kind: "unreadable" } }));
vi.mock("@/lib/bot-api/reads/account", async (orig) => ({ ...(await orig<typeof import("@/lib/bot-api/reads/account")>()), openLegsValuePnl: () => leg.v }));

import { checkOrderCaps, resolveCaps, notionalCapAtoms, DEFAULT_SLIPPAGE_BPS } from "@/lib/bot-api/builders/caps";
import type { TradePreflight } from "@/lib/v22/trade-build";
import { ApiError } from "@/lib/bot-api/errors";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { PublicKey } from "@solana/web3.js";
import { GATO_DATA, pk } from "./fake-chain";

// A real devnet v2.2 market: its collateral mint is the 6-decimal Sim-USDC the cap is valued in.
const MARKET = new Uint8Array(GATO_DATA);

const PX = 2_000_000n; // 2.00 per q-unit (E6)
const pf = (o: Partial<TradePreflight> = {}): TradePreflight => ({
  size: 1_000_000_000n, // 1e9 q x 2.0 = 2,000 USD notional
  limitPriceE6: PX + PX / 100n,
  effectivePriceE6: PX,
  positionBeforeQ: 0n,
  positionLegReset: false,
  reducing: false,
  marketData: MARKET,
  portfolioData: new Uint8Array(1),
  programId: pk(1),
  market: pk(2),
  lp: { accountB: pk(3), matcherCtx: pk(4) },
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
  __setDevnetV22ForTest(true);
  leg.v = { kind: "flat" };
  risk.v = { capital: 1_000_000_000n, pnl: 0n, feeCredits: 0n }; // 1,000 USD equity
  risk.maxLev = 20;
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setDevnetV22ForTest(null);
});

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
    // a prior-reset leg owns nothing: reduce-only has nothing to reduce
    expect(code(() => checkOrderCaps(ro, pf({ positionBeforeQ: 0n, positionLegReset: true, reducing: false })))).toBe("no_position");
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

describe("council fixes", () => {
  const open = (valuePnl: bigint) => {
    leg.v = { kind: "open", valuePnl };
  };
  it("risk F2: an under-water open leg lowers the equity the leverage cap divides by", () => {
    // capital 1,000 USD, settled pnl 0 (risk.pnl), but the open long is down 300 at the mark: equity 700.
    // existing 1e9 (2,000 USD) + buy 1e9 = 4,000 USD -> 5.71x on 700, 4x on 1,000.
    const c = caps({ explicitLimit: false, maxLeverage: 5 });
    expect(code(() => checkOrderCaps(c, pf({ positionBeforeQ: 1_000_000_000n })))).toBe("ok"); // flat leg: settled pnl 0
    open(-300_000_000n);
    expect(code(() => checkOrderCaps(c, pf({ positionBeforeQ: 1_000_000_000n })))).toBe("leverage_cap_exceeded");
    open(900_000_000n); // gains are not margin
    expect(code(() => checkOrderCaps(c, pf({ positionBeforeQ: 1_000_000_000n })))).toBe("ok");
    leg.v = { kind: "unreadable" };
    expect(code(() => checkOrderCaps(c, pf({ positionBeforeQ: 1_000_000_000n })))).toBe("market_unreadable");
  });
  it("risk F3: an unreadable position refuses every order, not only reduce-only ones", () => {
    expect(code(() => checkOrderCaps(caps(), pf({ positionBeforeQ: null })))).toBe("market_unreadable");
    expect(code(() => checkOrderCaps(caps({ explicitLimit: false, reduceOnly: true }), pf({ positionBeforeQ: null })))).toBe("market_unreadable");
  });
  it("risk F4: a fractional maxNotionalUsd is compared in atoms and the message reports it", () => {
    // 100.50 USD order: 50.25e6 q x 2.0
    const order = pf({ size: 50_250_000n });
    expect(code(() => checkOrderCaps(caps({ explicitLimit: false, maxNotionalUsd: 100.9 }), order))).toBe("ok");
    let msg = "";
    try {
      checkOrderCaps(caps({ explicitLimit: false, maxNotionalUsd: 100.4 }), order);
    } catch (e) {
      msg = (e as ApiError).message;
    }
    expect(msg).toContain("100.4 USD");
    expect(notionalCapAtoms(100.9, 6)).toBe(100_900_000n);
    expect(notionalCapAtoms(1, 9)).toBe(1_000_000_000n);
  });
  it("attacker: a collateral the API cannot value is market_unsupported for opens; a reducing order is never blocked by it", () => {
    const other = new Uint8Array(GATO_DATA);
    const mintOff = indexOfMint(other);
    other.set(new PublicKey(new Uint8Array(32).fill(7)).toBytes(), mintOff);
    expect(code(() => checkOrderCaps(caps(), pf({ marketData: other })))).toBe("market_unsupported");
    expect(code(() => checkOrderCaps(caps({ explicitLimit: false, reduceOnly: true }), pf({ marketData: other, positionBeforeQ: 5_000_000_000n, size: -1_000_000_000n, reducing: true })))).toBe("ok");
  });
});

function indexOfMint(d: Uint8Array): number {
  const mint = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC").toBytes();
  const i = Buffer.from(d).indexOf(Buffer.from(mint));
  if (i < 0) throw new Error("mint not found in fixture");
  return i;
}
