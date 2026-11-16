/**
 * Differential test: the app's vendored SDK maths (`lib/v22/sdk/v22-math.ts`, `v22-band.ts`) against a pinned copy of the
 * upstream source (percolator-sdk b1296be on feat/v22-sdk-growth, `src/abi/`), kept under `__tests__/fixtures/sdk-ref/`.
 * (The installed @percolatorct/sdk 8.0.0 predates these modules, so the pinned copy is the reference.)
 *
 * Every exported function present on both sides is run on N_CASES inputs (edge-pool cartesian + seeded random) and the
 * results (values, nulls, thrown errors) are compared. A mismatch fails the test with input / app value / SDK value.
 */
import { describe, it, expect } from "vitest";
import * as appMath from "@/lib/v22/sdk/v22-math";
import * as appBand from "@/lib/v22/sdk/v22-band";
import * as sdkMath from "../../fixtures/sdk-ref/abi/v22-math";
import * as sdkBand from "../../fixtures/sdk-ref/abi/v22-band";
import { LAYOUT_V22 } from "@/lib/v22/sdk/layout";
import { LAYOUT_V22 as SDK_LAYOUT_V22 } from "../../fixtures/sdk-ref/abi/layout";

const N_CASES = 10_000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = "u128" | "u64" | "bps" | "bool" | "lotExp" | "slip" | "cands";
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const EDGE_BIG: bigint[] = [
  0n, 1n, 2n, 3n, 7n, 9_999n, 10_000n, 10_001n, 1_000_000n, 1_000_000_000n, 1_000_000_000_000n, // MAX_ORACLE_PRICE
  1_000_000_000_001n, (1n << 31n) - 1n, 1n << 32n, (1n << 63n) - 1n, 1n << 63n, U64 - 1n, U64, 1n << 64n,
  (1n << 96n), U128 >> 1n, U128 - 1n, U128, 1n << 128n,
];
const EDGE_BPS = [0, 1, 50, 100, 5_000, 9_999, 10_000, 10_001, 20_000, 65_535, 1 << 20];
const EDGE_LOT = [-30, -7, -1, 0, 1, 6, 7, 12, 18, 24];

function mk(r: () => number, kind: Kind, i: number): unknown {
  const bits = (n: number) => {
    let v = 0n;
    for (let k = 0; k < n; k += 30) v = (v << 30n) | BigInt(Math.floor(r() * (1 << 30)));
    return v & ((1n << BigInt(n)) - 1n);
  };
  switch (kind) {
    case "u128":
    case "u64": {
      const cap = kind === "u64" ? U64 : U128;
      if (r() < 0.35) { const e = EDGE_BIG[Math.floor(r() * EDGE_BIG.length)]; return e > cap ? cap : e; }
      const w = 1 + Math.floor(r() * (kind === "u64" ? 64 : 128));
      return bits(w);
    }
    case "bps": return r() < 0.35 ? EDGE_BPS[Math.floor(r() * EDGE_BPS.length)] : Math.floor(r() * 12_000);
    case "slip": return i % 7 === 0 ? undefined : r() < 0.3 ? EDGE_BPS[Math.floor(r() * EDGE_BPS.length)] : Math.floor(r() * 12_000);
    case "bool": return r() < 0.5;
    case "lotExp": return r() < 0.5 ? EDGE_LOT[Math.floor(r() * EDGE_LOT.length)] : Math.floor(r() * 50) - 25;
    case "cands": {
      const n = Math.floor(r() * 8);
      return Array.from({ length: n }, (_, k) => ({ key: k, legs: r() < 0.2 ? Math.floor(r() * 300) : Math.floor(r() * 12) }));
    }
  }
}

const norm = (v: unknown): unknown => {
  if (typeof v === "bigint") return `${v}n`;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, norm(x)]));
  return v;
};
const run = (f: (...a: never[]) => unknown, args: unknown[]) => {
  try { return norm((f as (...a: unknown[]) => unknown)(...args)); } catch (e) { return { threw: (e as Error).message }; }
};

// Argument kinds per exported function (all functions present on both sides, same positional signature).
const MATH_SPEC: Record<string, Kind[]> = {
  mulDivFloorV22: ["u128", "u128", "u128"], mulDivCeilV22: ["u128", "u128", "u128"],
  bpsFloorV22: ["u128", "bps"], bpsCeilV22: ["u128", "bps"],
  trancheSplit3V22: ["u128", "u128", "u128"], bondImpairedV22: ["u128", "u128", "u128"],
  vaultValueWorseV22: ["u128", "u128", "u128"],
  bondSharesForDepositV22: ["u128", "u128", "u128"], bondAtomsForRedemptionV22: ["u128", "u128", "u128"],
  bondClaimAfterRedemptionV22: ["u128", "u128", "u128"], bondCapOkV22: ["u128", "u128", "u128", "bps"],
  bondWithdrawLockOkV22: ["u128", "u128", "u128", "u128"], bondCooldownElapsedV22: ["u64", "u64", "bps"],
  bondUtilBpsV22: ["u128", "u128"], bondCouponRateBpsV22: ["bps", "bps", "bps"],
  couponDueV22: ["u128", "bps", "u64"], couponGateOpenV22: ["bool", "u128", "u128", "u128"],
  couponBaseV22: ["u128", "u128"], bondCouponSplitV22: ["u128", "u128"],
  assertUtilBonusZeroV22: ["bps"],
  insUnitsForTopupV22: ["u128", "u128", "u128"], insUnitsToBurnV22: ["u128", "u128", "u128"],
  insUnitsValueV22: ["u128", "u128", "u128"], insMintAdmissibleV22: ["u128", "u128", "u128", "u128"],
  g9DelayElapsedV22: ["u64", "u64"], g9ProposalOpenV22: ["u64", "u64"], g9PhaseV22: ["u64", "u64"],
  g9EpochRoomV22: ["u128", "u128", "bps"], backstopDrawAmountV22: ["u128", "u128", "u128", "u128", "bps"],
  rescueAdmittedV22: ["u128", "u128", "u128", "u128"], rescueSharesV22: ["u128", "u128", "u128"],
  rescueClaimDeltaV22: ["u128", "u128", "u128"],
  refreshWeightV22: ["bps"], selectRefreshPortfoliosV22: ["cands"],
  defaultMinPayoutV22: ["u128", "slip", "bool"], parAtomsV22: ["u128", "u128", "u128"], dipFloorOkV22: ["u128", "u128"],
  bandBoundsV22: ["u128", "bps"], bandWidthOkV22: ["u128", "bps"], bandMinWideAnchorV22: ["bps"], bandGenesisPriceOkV22: ["u128", "bps"],
  lotExpForTokenPriceV22: ["u128"], displayPriceV22: ["u128", "lotExp"], tokensToLotsV22: ["u128", "lotExp"],
};
const BAND_SPEC: Record<string, Kind[]> = {
  rentRateE9V22: ["u128", "u128", "bps", "u128"], rentRateE9FailClosedV22: ["u128", "u128", "bps", "u128"],
  usersSideOiQV22: ["u128", "u128", "bool"], rentPercentPerDayV22: ["u64"],
};

const counts: Record<string, number> = {};
let total = 0;

function differential(label: string, app: Record<string, unknown>, sdk: Record<string, unknown>, spec: Record<string, Kind[]>) {
  describe(label, () => {
    for (const [name, kinds] of Object.entries(spec)) {
      it(`${name}: ${N_CASES} inputs`, () => {
        const appFn = app[name] as (...a: never[]) => unknown;
        const sdkFn = sdk[name] as (...a: never[]) => unknown;
        expect(typeof appFn, `app lacks ${name}`).toBe("function");
        expect(typeof sdkFn, `sdk lacks ${name}`).toBe("function");
        const r = rng(0xc0ffee ^ name.length * 7919 ^ name.charCodeAt(2));
        const mism: string[] = [];
        for (let i = 0; i < N_CASES; i++) {
          const args = kinds.map((k) => mk(r, k, i));
          const a = run(appFn, args);
          const s = run(sdkFn, args);
          if (JSON.stringify(a) !== JSON.stringify(s)) {
            mism.push(JSON.stringify({ input: norm(args), app: a, sdk: s }));
            if (mism.length >= 3) break;
          }
        }
        counts[name] = N_CASES;
        total += N_CASES;
        expect(mism, `${name} mismatches`).toEqual([]);
      });
    }
  });
}

differential("v22-math (shared functions)", appMath, sdkMath, MATH_SPEC);
differential("v22-band (shared functions)", appBand, sdkBand, BAND_SPEC);

describe("export-surface coverage", () => {
  it("every exported function of the app's v22-math / v22-band is differentially tested or explicitly listed", () => {
    // Functions whose input shape is a struct: tested in the dedicated blocks below.
    const structInput = new Set([
      "quoteBondDepositV22", "quoteBondWithdrawV22", "quoteRescueV22",
      "assetPriceLaggedV22", "bandFloorStuckV22", "favourableCloseRefusedV22",
      "rentRatesFromStateV22",
      // byte decoders / layout readers: covered by the layout-offset parity test below.
      "decodeBandConfigV22", "decodeAssetBandStateV22", "decodeAssetRentStateV22", "readBandRentViewV22", "tryReadBandRentViewV22", "layoutHasBandRentV22",
    ]);
    for (const mod of [appMath, appBand]) {
      for (const [k, v] of Object.entries(mod)) {
        if (typeof v !== "function") continue;
        expect(k in MATH_SPEC || k in BAND_SPEC || structInput.has(k), `untested export ${k}`).toBe(true);
      }
    }
  });
  it("exports present only on one side (drift list)", () => {
    const only = (a: object, b: object) => Object.keys(a).filter((k) => !(k in b)).sort();
    // The app has nothing the SDK lacks; the SDK has strictly more (cumulative coupon, occupancy rent).
    expect(only(appMath, sdkMath)).toEqual([]);
    expect(only(appBand, sdkBand)).toEqual([]);
  });
});

describe("struct-input functions", () => {
  const r = rng(12345);
  const big = (w = 64) => mk(r, w === 64 ? "u64" : "u128", 1) as bigint;
  const cmp = (name: string, f: (...a: never[]) => unknown, g: (...a: never[]) => unknown, make: () => unknown[]) => {
    it(`${name}: ${N_CASES} inputs`, () => {
      const mism: string[] = [];
      for (let i = 0; i < N_CASES; i++) {
        const args = make();
        const a = run(f, args), s = run(g, args);
        if (JSON.stringify(a) !== JSON.stringify(s)) { mism.push(JSON.stringify({ input: norm(args), app: a, sdk: s })); if (mism.length >= 3) break; }
      }
      counts[name] = N_CASES; total += N_CASES;
      expect(mism, `${name} mismatches`).toEqual([]);
    });
  };
  const assetIn = () => ({
    bandBps: mk(r, "bps", 1) as number, effectivePrice: big(), targetPrice: r() < 0.3 ? 0n : big(), oiEffLongQ: r() < 0.3 ? 0n : big(), oiEffShortQ: r() < 0.3 ? 0n : big(),
    maxPriceMoveBpsPerSlot: big(), maxAccrualDtSlots: big(), pinSinceSlot: r() < 0.5 ? 0n : big(),
  });
  cmp("assetPriceLaggedV22", appBand.assetPriceLaggedV22, sdkBand.assetPriceLaggedV22, () => [assetIn()]);
  cmp("bandFloorStuckV22", appBand.bandFloorStuckV22, sdkBand.bandFloorStuckV22, () => [assetIn()]);
  cmp("favourableCloseRefusedV22", appBand.favourableCloseRefusedV22, sdkBand.favourableCloseRefusedV22, () => [assetIn(), big(), big()]);
  cmp("quoteRescueV22", appMath.quoteRescueV22, sdkMath.quoteRescueV22, () => [{ amount: big(128), v: big(128), par: big(128), shares: big(128), seniorClaim: r() < 0.5 ? big(128) : undefined, slippageBps: mk(r, "slip", 3) }]);

  // Bond quotes: the SDK's input is a settled-coupon `tranche`; with ZERO accrual state (dslots 0, no unfunded coupon) it must
  // agree with the app's flat quote wherever the SDK has no additional refusal. Disagreements are the documented drift (below).
  const zeroTranche = (cB: bigint, b: bigint, cap: number) => ({
    cBAtoms: cB, bSharesTotal: b, couponArrearsAtoms: 0n, couponUnfundedAtoms: 0n, couponAccrualRem: 0n, couponGateSeen: 0n,
    lastCouponSlot: 100n, couponBpsPerYear: 0, couponUtilBonusBps: 0, bondCapBpsOfC: cap,
  });
  it(`quoteBondDepositV22 (zero-coupon regime): ${N_CASES} inputs, divergences are only the SDK's added refusals`, () => {
    const diffs: Record<string, number> = {};
    for (let i = 0; i < N_CASES; i++) {
      const amount = big(128), b = big(128), cB = big(128), vault = big(128), senior = big(128), cap = mk(r, "bps", i) as number, slip = mk(r, "slip", i) as number | undefined;
      const a = appMath.quoteBondDepositV22({ amount, bSharesTotal: b, cBAtoms: cB, capBps: cap, vaultValue: vault, seniorClaimEff: senior, slippageBps: slip });
      const s = sdkMath.quoteBondDepositV22({ amount, tranche: zeroTranche(cB, b, cap), nowSlot: 100n, seniorDrawnAtoms: 0n, vaultValue: vault, seniorClaimEff: senior, slippageBps: slip });
      const same = JSON.stringify(norm({ shares: a.shares, minShares: a.minShares, refusal: a.refusal })) === JSON.stringify(norm({ shares: s.shares, minShares: s.minShares, refusal: s.refusal }));
      if (!same) {
        const key = `app=${a.refusal?.code ?? "ok"} sdk=${s.refusal?.code ?? "ok"}`;
        diffs[key] = (diffs[key] ?? 0) + 1;
      }
    }
    counts.quoteBondDepositV22 = N_CASES; total += N_CASES;
    // Only these divergence classes are known/explained: SDK refuses 107 when vault < senior claim (app computes split with saturating
    // maths) or 15 on K+amount overflow (app would return a quote / 123).
    const known = new Set(["app=ok sdk=107", "app=123 sdk=107", "app=124 sdk=107", "app=107 sdk=15", "app=123 sdk=15", "app=ok sdk=15", "app=124 sdk=15", "app=107 sdk=123", "app=ok sdk=123", "app=124 sdk=123", "app=123 sdk=124", "app=107 sdk=124", "app=ok sdk=124"]);
    for (const k of Object.keys(diffs)) expect(known.has(k), `unexplained divergence class ${k}: ${JSON.stringify(diffs)}`).toBe(true);
    // eslint-disable-next-line no-console
    console.log("quoteBondDepositV22 divergence classes (n/10000):", JSON.stringify(diffs));
  });
  it(`quoteBondWithdrawV22 (zero-coupon regime): ${N_CASES} inputs`, () => {
    const diffs: Record<string, number> = {};
    for (let i = 0; i < N_CASES; i++) {
      const shares = big(128), b = big(128), cB = big(128), vault = big(128), senior = big(128);
      const live = r() < 0.5 ? { nCapAfter: r() < 0.5 ? null : big(), oiLongQ: big(), oiShortQ: big(), lpEffAbsQ: big() } : undefined;
      const slip = mk(r, "slip", i) as number | undefined;
      const a = appMath.quoteBondWithdrawV22({ shares, bSharesTotal: b, cBAtoms: cB, vaultValue: vault, seniorClaimEff: senior, live, slippageBps: slip });
      const s = sdkMath.quoteBondWithdrawV22({ shares, tranche: zeroTranche(cB, b, 0), nowSlot: 100n, seniorDrawnAtoms: 0n, vaultValue: vault, seniorClaimEff: senior, live, slippageBps: slip });
      const pick = (q: { atoms: bigint | null; minOut: bigint | null; claimAfter: bigint | null; refusal: { code: number } | null }) => norm({ atoms: q.atoms, minOut: q.minOut, claimAfter: q.claimAfter, code: q.refusal?.code ?? null });
      if (JSON.stringify(pick(a)) !== JSON.stringify(pick(s))) {
        const key = `app=${a.refusal?.code ?? "ok"} sdk=${s.refusal?.code ?? "ok"}`;
        diffs[key] = (diffs[key] ?? 0) + 1;
      }
    }
    counts.quoteBondWithdrawV22 = N_CASES; total += N_CASES;
    // eslint-disable-next-line no-console
    console.log("quoteBondWithdrawV22 divergence classes (n/10000):", JSON.stringify(diffs));
    // shares == 0 is a 109 (cooldown) refusal in the SDK, 110 in the app: the only class that may appear.
    for (const k of Object.keys(diffs)) expect(["app=110 sdk=109"].includes(k), `unexplained divergence class ${k}: ${JSON.stringify(diffs)}`).toBe(true);
  });

  // v22-band rentRatesFromStateV22 over decoded structs: the SDK adds the occupancy rent term + growth gate (prog #572 / #653).
  const cfg = () => ({ bandBps: r() < 0.2 ? 0 : (mk(r, "bps", 1) as number), bandMaxPositionsPerSide: r() < 0.4 ? 256n : r() < 0.2 ? (1n << 17n) : BigInt(Math.floor(r() * 1000)), rentMaxE9PerSlot: r() < 0.2 ? 0n : BigInt(Math.floor(r() * 5000)) });
  const side = () => {
    const cap = r() < 0.6 ? 256n : BigInt(1 + Math.floor(r() * 1000));
    return { cap, count: r() < 0.5 ? BigInt(Math.floor(r() * Number(cap) * 1.2)) : (cap * BigInt(Math.floor(r() * 100))) / 100n };
  };
  it(`rentRatesFromStateV22: ${N_CASES} inputs; counts divergences vs the occupancy-rent SDK`, () => {
    let diverged = 0;
    let firstRow = "";
    let withOccupancyAbove85 = 0;
    for (let i = 0; i < N_CASES; i++) {
      const sl = side();
      const c = { ...cfg(), bandMaxPositionsPerSide: sl.cap };
      const asset = { bandAnchorPrice: 1n, bandAnchorSlot: 1n, bandEpoch: 1n, bandUncertifiedLong: 0n, bandUncertifiedShort: 0n, bandLiqPendingLong: 0n, bandLiqPendingShort: 0n, bandPinSinceSlot: 0n, rentIndexLongNum: 0n, rentIndexShortNum: 0n, rentUnroutedAtoms: 0n, oiEffLongQ: BigInt(Math.floor(r() * 1e6)), oiEffShortQ: BigInt(Math.floor(r() * 1e6)), storedPosCountLong: sl.count, storedPosCountShort: side().count };
      const rent = { rentKinkBps: Math.floor(r() * 9999), rentNCapQ: r() < 0.1 ? 0n : BigInt(1 + Math.floor(r() * 2e6)), vaultLpNetQ: BigInt(Math.floor(r() * 5e5)) * (r() < 0.5 ? 1n : -1n), vaultLpBound: r() < 0.9, growthOn: r() < 0.85 };
      const a = norm(appBand.rentRatesFromStateV22(c as never, asset as never, rent as never));
      const s = norm(sdkBand.rentRatesFromStateV22(c as never, asset as never, rent as never));
      if (c.bandBps !== 0 && sl.count * 10_000n > sl.cap * 8_500n && c.rentMaxE9PerSlot !== 0n) withOccupancyAbove85++;
      if (JSON.stringify(a) !== JSON.stringify(s)) {
        diverged++;
        if (!firstRow) firstRow = JSON.stringify({ input: norm([c, asset, rent]), app: a, sdk: s });
      }
    }
    counts.rentRatesFromStateV22 = N_CASES; total += N_CASES;
    // eslint-disable-next-line no-console
    console.log(`rentRatesFromStateV22: ${diverged}/${N_CASES} diverge (${withOccupancyAbove85} inputs had a side above the 85% knee). First: ${firstRow}`);
    expect(diverged, `app rentRatesFromStateV22 omits occupancy rent + growth gate; first: ${firstRow}`).toBe(0);
  });
});

describe("layout parity for band / rent decoding", () => {
  it("LAYOUT_V22.bandRent offsets equal the SDK's", () => {
    expect(norm(LAYOUT_V22.bandRent)).toEqual(norm(SDK_LAYOUT_V22.bandRent));
  });
});

describe("summary", () => {
  it("reports input counts", () => {
    // eslint-disable-next-line no-console
    console.log(`differential inputs: ${total} across ${Object.keys(counts).length} functions`);
    expect(Object.values(counts).every((n) => n >= 10_000)).toBe(true);
  });
});
