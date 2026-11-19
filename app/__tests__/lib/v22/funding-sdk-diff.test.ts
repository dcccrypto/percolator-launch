// @vitest-environment node
/**
 * Differential test: the app's funding reader (lib/v22/funding.ts decodeFundingV22) vs the SDK's independent decoder
 * (percolator-sdk src/abi/v22-funding.ts decodeMarketFundingV22), on (a) the real devnet fixtures and (b) 6,000 synthetic
 * markets made by writing random values into a real fixture at the documented offsets.
 *
 * The pinned npm SDK (8.0.0) does not ship decodeMarketFundingV22 yet (it lands with the v22 SDK, feat/v22-sdk-integration),
 * so the SDK source is loaded from a checkout named by PERCOLATOR_SDK_SRC (the SDK repo's `src/abi/v22-funding.ts`). The
 * suite is skipped when it is unset, so CI on the pinned SDK is unaffected.
 *
 * Compared per asset: the applied rate (rate when both sides hold exposure, else 0) and its sign/payer, plus premium and skew.
 * That case: funding_mark_e6 == 0 and mark_ewma_last_slot > asset slot_last. The wrapper (`permissionless_funding_rate_e9_view`)
 * returns 0 for the WHOLE rate (premium and skew); the app now does too; the SDK falls back to mark_ewma_e6 and keeps skew
 * (an SDK bug, reported). Those cases are excluded from the app-vs-SDK sweep and pinned against the wrapper separately.
 */
import { describe, expect, it } from "vitest";
import fx from "../../fixtures/v22-devnet-markets-2026-10-14.json";
import { decodeFundingV22 } from "@/lib/v22/funding";
import { resolveMarketGeometry } from "@/lib/v22/sdk";
import { engineConfigOff } from "@/lib/v17-engine-config";

const SDK_SRC = process.env.PERCOLATOR_SDK_SRC;
type SdkAsset = {
  assetIndex: number; rateE9PerSlot: bigint; premiumRateE9PerSlot: bigint; skewRateE9PerSlot: bigint;
  payer: "longs" | "shorts" | "none"; fundingActive: boolean;
};
type SdkDecode = (d: Uint8Array) => { maxAbsFundingE9PerSlot: bigint; assets: SdkAsset[] };
const sdk: { decode?: SdkDecode } = {};
if (SDK_SRC) sdk.decode = ((await import(/* @vite-ignore */ `${SDK_SRC}/src/abi/v22-funding.ts`)) as { decodeMarketFundingV22: SdkDecode }).decodeMarketFundingV22;

const NAMES = ["swordcat", "SOL", "JUP"] as const;
const base = (k: (typeof NAMES)[number]): Uint8Array => new Uint8Array(Buffer.from(fx[k].data, "base64"));

// mulberry32 + bigint helpers: deterministic, so a mismatch is reproducible from its seed.
function rng(seed: number) {
  let s = seed >>> 0;
  const f = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const u = (max: bigint): bigint => {
    let r = 0n;
    for (let i = 0; i < 5; i++) r = (r << 32n) | BigInt(Math.floor(f() * 4294967296));
    return r % (max + 1n);
  };
  return { f, u, pick: <T,>(a: T[]): T => a[Math.floor(f() * a.length)] };
}

interface Synth { data: Uint8Array; desc: string }
function synth(seed: number): Synth {
  const r = rng(seed);
  const name = r.pick([...NAMES]);
  const data = base(name);
  const g = resolveMarketGeometry(data, { parser: "t", strictLength: false });
  const dv = new DataView(data.buffer);
  const set64 = (o: number, v: bigint): void => dv.setBigUint64(o, v, true);
  const set128 = (o: number, v: bigint): void => {
    const m = BigInt.asUintN(128, v);
    dv.setBigUint64(o, m & ((1n << 64n) - 1n), true);
    dv.setBigUint64(o + 8, m >> 64n, true);
  };
  const log = (): bigint => r.u((1n << BigInt(1 + Math.floor(r.f() * 62))) - 1n); // log-uniform magnitudes
  const oneOf = (small: bigint, wide: bigint): bigint => (r.f() < 0.15 ? 0n : r.f() < 0.5 ? r.u(small) : wide);
  const maxAbs = r.f() < 0.1 ? 0n : 1n + (r.f() < 0.5 ? r.u(1000n) : r.u(500_000_000n));
  set64(engineConfigOff(data)! + 126, maxAbs);
  const parts: string[] = [`seed=${seed} base=${name} maxAbs=${maxAbs}`];
  for (let i = 0; i < g.slotCount; i++) {
    const w = g.slotOff(i);
    const e = g.engineOff(i);
    const v = w + 896;
    const index = 1n + log();
    const nearIdx = r.f() < 0.5;
    const mark = r.f() < 0.15 ? 0n : nearIdx ? index + BigInt(Math.floor((r.f() - 0.5) * 2000)) : log();
    const mode = r.f() < 0.7 ? 1 + Math.floor(r.f() * 3) : r.pick([0, 4, 7, 255]);
    const slotLast = r.u(1_000_000n);
    const ewmaSlot = r.f() < 0.3 ? slotLast + r.u(50n) : r.u(slotLast);
    const ewma = r.f() < 0.2 ? 0n : nearIdx ? index + BigInt(Math.floor((r.f() - 0.5) * 2000)) : log();
    const oiL = oneOf(1_000n, log());
    const oiS = oneOf(1_000n, log());
    const side = oiL > oiS ? oiL : oiS;
    const lpMag = r.f() < 0.15 ? 0n : r.f() < 0.5 ? r.u(side + 5n) : log();
    const lp = r.f() < 0.5 ? -lpMag : lpMag;
    const slope = oneOf(200n, r.u(2_000_000_000n));
    const skewMax = oneOf(200n, r.u(2_000_000_000n));
    const flags = Math.floor(r.f() * 256);
    data[w] = mode;
    set64(w + 168, ewma);
    set64(w + 176, ewmaSlot);
    set64(w + 432, mark);
    set64(e + 25, index);
    set64(e + 41, slotLast);
    set128(e + 289, oiL);
    set128(e + 305, oiS);
    set128(v + 32, lp);
    set64(v + 72, slope);
    set64(v + 80, skewMax);
    data[v + 90] = flags;
    parts.push(`[a${i} mode=${mode} mark=${mark} ewma=${ewma}@${ewmaSlot} idx=${index}@${slotLast} oi=${oiL}/${oiS} lp=${lp} slope=${slope} max=${skewMax} flags=${flags}]`);
  }
  return { data, desc: parts.join(" ") };
}

const hex = (d: Uint8Array, o: number, n: number): string => Buffer.from(d.subarray(o, o + n)).toString("hex");

/** Compare one market; returns mismatch strings (empty = equal). `ewmaGap` cases are the known SDK divergence. */
function compare(data: Uint8Array, desc: string, skipEwmaGap: boolean): string[] {
  const sdkM = sdk.decode!(data);
  const g = resolveMarketGeometry(data, { parser: "t", strictLength: false });
  const out: string[] = [];
  for (let i = 0; i < g.slotCount; i++) {
    const w = g.slotOff(i);
    const e = g.engineOff(i);
    const dv = new DataView(data.buffer, data.byteOffset);
    const mark = dv.getBigUint64(w + 432, true);
    const ewmaGap = mark === 0n && dv.getBigUint64(w + 176, true) > dv.getBigUint64(e + 41, true);
    if (skipEwmaGap && ewmaGap) continue;
    const a = decodeFundingV22(data, i)!;
    const s = sdkM.assets[i]!;
    const sApplied = s.fundingActive ? s.rateE9PerSlot : 0n;
    const aApplied = a.bothSides ? a.rateE9PerSlot : 0n;
    const sDir = !s.fundingActive || s.payer === "none" ? "none" : s.payer === "longs" ? "longs-pay-shorts" : "shorts-pay-longs";
    const bad = a.maxAbsE9 !== sdkM.maxAbsFundingE9PerSlot || aApplied !== sApplied || a.direction !== sDir ||
      a.premiumE9 !== s.premiumRateE9PerSlot || a.skewE9 !== s.skewRateE9PerSlot || a.rateE9PerSlot !== s.rateE9PerSlot;
    if (bad) {
      out.push(`MISMATCH asset ${i}: app rate=${a.rateE9PerSlot} applied=${aApplied} dir=${a.direction} prem=${a.premiumE9} skew=${a.skewE9} | sdk rate=${s.rateE9PerSlot} applied=${sApplied} dir=${sDir} prem=${s.premiumRateE9PerSlot} skew=${s.skewRateE9PerSlot}\n  ${desc}\n  profile[0..8]=${hex(data, w, 8)} @168=${hex(data, w + 168, 16)} @432=${hex(data, w + 432, 8)} vaultLp@32=${hex(data, w + 896 + 32, 16)} @72=${hex(data, w + 896 + 72, 20)} engine@25=${hex(data, e + 25, 24)} oi=${hex(data, e + 289, 32)}`);
    }
  }
  return out;
}

describe.skipIf(!SDK_SRC)("app decodeFundingV22 vs SDK decodeMarketFundingV22", () => {
  it.each(NAMES)("real devnet fixture %s: applied rate, sign and components match", (k) => {
    expect(compare(base(k), `fixture ${k}`, false)).toEqual([]);
  });

  it("6,000 synthetic markets (random mark/index/oi/lp_net/slope/max/flags/oracle_mode): applied rate and sign match for every asset", () => {
    const N = 6000;
    const mism: string[] = [];
    let signs = { pos: 0, neg: 0, zero: 0 };
    for (let seed = 1; seed <= N; seed++) {
      const { data, desc } = synth(seed);
      mism.push(...compare(data, desc, true));
      const a = decodeFundingV22(data, 0)!;
      const ap = a.bothSides ? a.rateE9PerSlot : 0n;
      if (ap > 0n) signs.pos++; else if (ap < 0n) signs.neg++; else signs.zero++;
    }
    // the sweep must actually exercise both signs, not trivially compare zeros
    expect(signs.pos).toBeGreaterThan(200);
    expect(signs.neg).toBeGreaterThan(200);
    expect(mism.slice(0, 5)).toEqual([]);
    expect(mism).toHaveLength(0);
  });

  it("KNOWN SDK DIVERGENCE pinned: mark==0 and ewma slot ahead -> SDK still derives a premium from mark_ewma_e6 (wrapper: whole rate 0)", () => {
    const data = ewmaAhead();
    expect(sdk.decode!(data).assets[0]!.premiumRateE9PerSlot).not.toBe(0n);
  });
});

function ewmaAhead(): Uint8Array {
  const data = base("swordcat");
  const g = resolveMarketGeometry(data, { parser: "t", strictLength: false });
  const w = g.slotOff(0), e = g.engineOff(0);
  const dv = new DataView(data.buffer);
  dv.setBigUint64(w + 432, 0n, true);
  dv.setBigUint64(w + 168, dv.getBigUint64(e + 25, true) + 1n, true);
  dv.setBigUint64(w + 176, dv.getBigUint64(e + 41, true) + 1n, true);
  return data;
}

describe("wrapper early return (permissionless_funding_rate_e9_view): mark==0 and mark_ewma_last_slot > slot_last -> whole rate 0", () => {
  it("app applies no premium AND no vault-LP skew (swordcat has skew 55 otherwise)", () => {
    const f = decodeFundingV22(ewmaAhead())!;
    expect(f.premiumE9).toBe(0n);
    expect(f.skewE9).toBe(0n);
    expect(f.rateE9PerSlot).toBe(0n);
    expect(f.direction).toBe("none");
  });
});
