/** Deterministic input generator shared by the matcher-quote bench and the differential test (not a test file). */
import type { MatcherCtxView, V2BlockView } from "@/lib/limits/decode";
import type { MatcherExtCaps } from "@/lib/limits/matcher-quote";

export interface QuoteCase {
  ctx: MatcherCtxView;
  oracleE6: bigint;
  sizeQ: bigint;
  takerBuys: boolean;
  opts: { bandBps?: number; headroomQ?: bigint; ext?: MatcherExtCaps | null; takerReducing?: boolean; nowSlot?: bigint };
  limitE6: bigint;
  invRef: bigint;
}

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function genCases(n: number, seed: number, edgy: boolean): QuoteCase[] {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  // log-uniform bigint in [1, 10^d]
  const big = (d: number): bigint => BigInt(Math.max(1, Math.floor(Math.pow(10, r() * d))));
  const out: QuoteCase[] = [];
  for (let i = 0; i < n; i++) {
    const refInv = edgy && r() < 0.05 ? 0n : big(10) * 100n;
    const v2: V2BlockView = {
      flags: 1,
      feeLoBps: int(0, 30),
      feeHiBps: int(0, 120),
      feeColdBps: int(0, 100),
      volAMilli: int(0, 2000),
      volBDen: edgy && r() < 0.1 ? 0 : int(1, 500),
      volAlphaBps: int(0, 11_000),
      volWarmupLeft: r() < 0.15 ? int(1, 5) : 0,
      volMoveCap10bps: int(0, 200),
      volRefSlots: int(0, 60),
      thinRebateMultBps: r() < 0.1 ? 0 : int(0, 400),
      skewCapBps: r() < 0.1 ? 0 : int(0, 300),
      rebateCapBps: r() < 0.1 ? 0 : int(0, 200),
      maxMarkAgeSlots: 150,
      observedStaleSlots: 0,
      boundAssetPlus1: 1,
      skewRefInventory: refInv,
      volVarE4: r() < 0.3 ? 0n : big(14),
      volLastPriceE6: r() < 0.1 ? 0n : big(7),
      volLastSlot: BigInt(int(0, 1000)),
    };
    const oracleE6 = edgy && r() < 0.02 ? 0n : big(8);
    const maxFillAbs = r() < 0.1 ? 0n : big(13);
    // inventory: includes exactly +/- the 10_000 bps cap of the reference inventory.
    const pickInv = r();
    const inventoryBase =
      pickInv < 0.15 ? refInv : pickInv < 0.3 ? -refInv : pickInv < 0.4 ? 0n : (BigInt(int(-12_000, 12_000)) * refInv) / 10_000n;
    const ctx: MatcherCtxView = {
      kind: r() < 0.05 ? 1 : 2,
      tradingFeeBps: 0,
      baseSpreadBps: int(0, 50),
      maxTotalBps: pick([0, 50, 100, 300, 800, 9_000, 9_500, 20_000]),
      impactKBps: r() < 0.1 ? 0 : int(1, 20_000),
      liquidityNotionalE6: big(14),
      maxFillAbs,
      inventoryBase,
      maxInventoryAbs: r() < 0.5 ? 0n : big(12),
      feeToInsuranceBps: 0,
      skewSpreadMultBps: r() < 0.1 ? 0 : int(0, 600),
      v2: r() < 0.03 ? null : v2,
    };
    const sizeQ = edgy && r() < 0.05 ? 0n : big(12);
    const extR = r();
    const ext: MatcherExtCaps | null =
      extR < 0.5
        ? null
        : {
            inventoryCapQ: pick([0n, big(11), 100_000_000_000_000n, 200_000_000_000_000n]),
            liquidityNotionalE6: r() < 0.3 ? 0n : big(14),
          };
    const opts: QuoteCase["opts"] = {};
    if (r() < 0.5) opts.bandBps = int(0, 1000);
    if (r() < 0.3) opts.headroomQ = big(12);
    if (ext) opts.ext = ext;
    if (r() < 0.3) opts.takerReducing = true;
    if (r() < 0.7) opts.nowSlot = BigInt(int(0, 1100));
    const limitE6 = edgy && r() < 0.15 ? 0n : big(8);
    out.push({ ctx, oracleE6, sizeQ, takerBuys: r() < 0.5, opts, limitE6, invRef: r() < 0.1 ? 0n : refInv });
  }
  return out;
}
