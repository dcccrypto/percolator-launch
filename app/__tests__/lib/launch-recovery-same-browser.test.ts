/**
 * #3377: a RESUME taken from this browser's RecoverSolBanner is pinned to what the launch signed (its
 * saved proof payload), not to the live form, which a reload or a new tab re-detects.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { deriveLaunchMarketParams } from "@/lib/market-params";
import { buildInitMatcherCtxArgs } from "@/lib/matcher-params";
import { flooredInitialMarginBps } from "@/lib/market-registration-payload";
import { leverageFromMarginBps } from "@/lib/market-params";
import {
  applySameBrowserPin,
  pinSameBrowserResume,
  SAME_BROWSER_RESUME_REFUSAL,
  type ResumableParams,
} from "@/lib/launch-recovery";
import { loadRegisterRequest, saveRegisterRequest, type KeyStore } from "@/lib/keeper-register-client";

const k = () => Keypair.generate().publicKey.toBase58();
const SLAB = k();
const POOL = k();
const OTHER_POOL = k();
const CA = k();
const WALLET = k();

const payload = (o: Record<string, unknown> = {}) => ({
  slab_address: SLAB, deployer: WALLET, symbol: "AUTON", name: "auton", dex_pool_address: POOL, mainnet_ca: CA,
  initial_price_e6: "3695", max_leverage: 10, trading_fee_bps: 7, lp_collateral: "4242000000", ...o,
});
const live: ResumableParams = {
  initialPriceE6: 9999n, tradingFeeBps: 30, initialMarginBps: 2000, lpCollateral: 1_000_000_000n,
  symbol: "DRIFT", name: "drift", mainnetCA: k(), dexPoolAddress: OTHER_POOL, dexType: "meteora-dlmm", oracleMode: "hyperp",
};

describe("pinSameBrowserResume (#3377)", () => {
  it("pins fee, price, LP, pool, symbol, name and CA from the proof payload, and dex type from the saved request", () => {
    const r = pinSameBrowserResume({ slab: SLAB, fromStep: 2, payload: payload(), savedRequest: { dexPoolAddress: POOL, dexType: "raydium-clmm" }, wallet: WALLET, chainMarginBps: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.pin) throw new Error("no pin");
    expect(r.pin).toMatchObject({ initialPriceE6: 3695n, tradingFeeBps: 7, lpCollateralAtoms: 4_242_000_000n, poolAddress: POOL, symbol: "AUTON", name: "auton", mainnetCA: CA, dexType: "raydium-clmm", initialMarginBps: 1000 });
    const out = applySameBrowserPin(live, r.pin);
    expect(out).toMatchObject({ initialPriceE6: 3695n, tradingFeeBps: 7, lpCollateral: 4_242_000_000n, dexPoolAddress: POOL, dexType: "raydium-clmm", symbol: "AUTON", mainnetCA: CA, oracleMode: "keeper" });
  });

  it("falls back to the live dex type only when live detection still names the pinned pool", () => {
    const same = pinSameBrowserResume({ slab: SLAB, fromStep: 3, payload: payload(), live: { poolAddress: POOL, dexType: "pumpswap" }, chainMarginBps: 1000 });
    expect(same.ok && same.pin?.dexType).toBe("pumpswap");
    const drifted = pinSameBrowserResume({ slab: SLAB, fromStep: 3, payload: payload(), live: { poolAddress: OTHER_POOL, dexType: "meteora-dlmm" }, chainMarginBps: 1000 });
    expect(drifted).toEqual({ ok: false, message: SAME_BROWSER_RESUME_REFUSAL });
  });

  it("FAIL SAFE: a missing, foreign or incomplete payload refuses", () => {
    const base = { slab: SLAB, fromStep: 2, savedRequest: { dexPoolAddress: POOL, dexType: "raydium-clmm" }, proofTx: "sig", chainMarginBps: 1000 };
    const refused = { ok: false, message: SAME_BROWSER_RESUME_REFUSAL };
    expect(pinSameBrowserResume({ ...base, payload: null })).toEqual(refused);
    expect(pinSameBrowserResume({ ...base, payload: payload({ slab_address: k() }) })).toEqual(refused);
    expect(pinSameBrowserResume({ ...base, payload: payload({ deployer: k() }), wallet: WALLET })).toEqual(refused);
    expect(pinSameBrowserResume({ ...base, payload: payload({ dex_pool_address: null }) })).toEqual(refused);
    expect(pinSameBrowserResume({ ...base, payload: payload({ lp_collateral: "nope" }) })).toEqual(refused);
  });

  it("step 0 and a launch with no keeper records are left to the live form (unchanged)", () => {
    expect(pinSameBrowserResume({ slab: SLAB, fromStep: 0, payload: null })).toEqual({ ok: true, pin: null });
    expect(pinSameBrowserResume({ slab: SLAB, fromStep: 3, payload: null, liveIsKeeper: false })).toEqual({ ok: true, pin: null });
    expect(pinSameBrowserResume({ slab: SLAB, fromStep: 3, payload: null, liveIsKeeper: true }).ok).toBe(false);
  });

  it("applySameBrowserPin(null) returns the params untouched, and keeps a junior tranche equal to the pinned LP", () => {
    expect(applySameBrowserPin(live, null)).toBe(live);
    const r = pinSameBrowserResume({ slab: SLAB, fromStep: 2, payload: payload(), savedRequest: { dexType: "raydium-clmm" }, chainMarginBps: 1000 });
    if (!r.ok || !r.pin) throw new Error("no pin");
    const p3 = applySameBrowserPin({ ...live, p3: { juniorFloorBps: 500, juniorAtoms: 1n } }, r.pin).p3;
    expect(p3).toEqual({ juniorFloorBps: 500, juniorAtoms: 4_242_000_000n });
  });
});

describe("margin comes from chain (#3377 review)", () => {
  it.each([1538, 2222, 1000, 3334])("a %i bps market resumes with the margin the launch signed", (bps) => {
    // The payload the launch saved carries max_leverage, derived exactly as buildMarketRegistrationPayload does.
    const maxLev = leverageFromMarginBps(flooredInitialMarginBps(bps));
    const r = pinSameBrowserResume({ slab: SLAB, fromStep: 2, payload: payload({ max_leverage: maxLev, lp_collateral: "1500000000" }), savedRequest: { dexType: "raydium-clmm" }, chainMarginBps: bps });
    if (!r.ok || !r.pin) throw new Error("no pin");
    expect(r.pin.initialMarginBps).toBe(bps);
    // What resumed step 2 signs (InitMatcherCtx args) equals what the original launch signed.
    const lp = 1_500_000_000n;
    const original = buildInitMatcherCtxArgs(7, deriveLaunchMarketParams({ initialMarginBps: bps, lpCollateral: lp, initialPriceE6: 3695n }).matcher);
    const resumed = applySameBrowserPin({ ...live, lpCollateral: lp }, r.pin);
    const resumedArgs = buildInitMatcherCtxArgs(Number(resumed.tradingFeeBps), deriveLaunchMarketParams({ initialMarginBps: resumed.initialMarginBps, lpCollateral: resumed.lpCollateral, initialPriceE6: resumed.initialPriceE6 }).matcher);
    expect(resumedArgs).toEqual(buildInitMatcherCtxArgs(7, deriveLaunchMarketParams({ initialMarginBps: bps, lpCollateral: 1_500_000_000n, initialPriceE6: 3695n }).matcher));
    expect(original).toBeDefined();
  });

  it("the old max_leverage re-derivation does NOT round-trip fractional leverage (why chain is read)", () => {
    for (const bps of [1538, 2222]) {
      const maxLev = leverageFromMarginBps(flooredInitialMarginBps(bps));
      expect(Math.ceil(10_000 / maxLev)).not.toBe(bps);
    }
  });

  it("FAIL SAFE: no readable on-chain margin refuses", () => {
    for (const chainMarginBps of [null, undefined, 0, 1538.5]) {
      expect(pinSameBrowserResume({ slab: SLAB, fromStep: 2, payload: payload(), savedRequest: { dexType: "raydium-clmm" }, chainMarginBps }).ok).toBe(false);
    }
  });
});

describe("loadRegisterRequest", () => {
  it("round-trips what startKeeperLoop saved, and ignores another slab's record", () => {
    const m = new Map<string, string>();
    const store: KeyStore = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (x) => m.get(x) ?? null, setItem: (x, v) => void m.set(x, v) };
    saveRegisterRequest({ slabAddress: SLAB, mainnetCA: CA, dexPoolAddress: POOL, dexType: "raydium-clmm", symbol: "AUTON" }, store);
    expect(loadRegisterRequest(SLAB, store)).toMatchObject({ dexPoolAddress: POOL, dexType: "raydium-clmm" });
    expect(loadRegisterRequest(k(), store)).toBeNull();
  });
});
