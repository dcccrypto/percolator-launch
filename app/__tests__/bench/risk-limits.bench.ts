// @vitest-environment node
/**
 * Bench for lib/limits/risk-limits (order-ticket hot path). Run:
 *   npx vitest bench --run --maxWorkers=4 __tests__/bench/risk-limits.bench.ts
 * Inputs mirror __tests__/lib/limits/risk-limits.test.ts (base fixture, LP short 400u, matcher caps,
 * floored LP, vault LP) and rust-parity boundary values. Each bench iteration = 100 calls.
 */
import { bench, describe } from "vitest";
import {
  bandEdgesE6,
  clampSizeQ,
  execPriceWithinBand,
  lpFillGate,
  lpTradeHeadroomQ,
  maxTradeSizePerSide,
  oiUtilisationBps,
  sameOwnerRoomQ,
  sideOiAfterFill,
  sideOiHeadroomQ,
  type SizeLimitInputs,
} from "@/lib/limits/risk-limits";

const base = (over: Partial<SizeLimitInputs> = {}): SizeLimitInputs => ({
  priceE6: 1_000_000n,
  initialMarginBps: 1_000n,
  oiEffLongQ: 0n,
  oiEffShortQ: 0n,
  limits: { sideOiCapQ: 0n, lpFloorAtoms: 0n, lpExposureKBps: 0 },
  lp: { posQ: 0n, capital: 100_000_000n, pnl: 0n, feeCredits: 0n },
  takerPosQ: 0n,
  matcher: null,
  ...over,
});
const SCEN: SizeLimitInputs[] = [
  base(),
  base({ lp: { posQ: -400_000_000n, capital: 100_000_000n, pnl: 0n, feeCredits: 0n }, oiEffLongQ: 400_000_000n, oiEffShortQ: 400_000_000n }),
  base({ matcher: { maxFillAbs: 250_000_000n, maxInventoryAbs: 0n, inventoryBase: 0n } }),
  base({ limits: { sideOiCapQ: 500_000_000n, lpFloorAtoms: 0n, lpExposureKBps: 0 }, oiEffLongQ: 100_000_000n, oiEffShortQ: 100_000_000n, takerPosQ: 50_000_000n }),
  base({ limits: { sideOiCapQ: 0n, lpFloorAtoms: 200_000_000n, lpExposureKBps: 0 }, lp: { posQ: 300_000_000n, capital: 100_000_000n, pnl: -5n, feeCredits: -3n } }),
  base({ vaultLp: { levBps: 10_000 }, matcher: { maxFillAbs: 0n, maxInventoryAbs: 900_000_000n, inventoryBase: 100_000_000n, lpRealQ: 120_000_000n, syncLive: true } }),
  base({ lp: null }),
];

describe("risk-limits (100 calls / iteration)", () => {
  bench("maxTradeSizePerSide", () => {
    for (let n = 0; n < 100; n++) maxTradeSizePerSide(SCEN[n % SCEN.length]);
  });
  bench("sideOiHeadroomQ", () => {
    for (let n = 0; n < 100; n++) {
      const s = SCEN[n % SCEN.length];
      sideOiHeadroomQ(s.oiEffLongQ, s.oiEffShortQ, s.takerPosQ, s.lp?.posQ ?? 0n, n & 1 ? "long" : "short", 500_000_000n);
    }
  });
  bench("sideOiAfterFill + lpTradeHeadroomQ + lpFillGate + misc", () => {
    for (let n = 0; n < 100; n++) {
      const sz = BigInt(n * 1_000_000 - 50_000_000);
      sideOiAfterFill(100n, 200n, 5n, -7n, sz);
      lpTradeHeadroomQ(BigInt(n - 50), n & 1 ? "long" : "short", 40n, (n & 3) === 0);
      lpFillGate(0n, 0n, BigInt(n - 50), BigInt(50 - n), 30n, (n & 7) === 0);
      execPriceWithinBand(1_000_000n + BigInt(n), 1_000_000n, 50);
      bandEdgesE6(1_000_000n, 50);
      clampSizeQ(BigInt(n), { maxQ: 40n, reason: "none", halted: false });
      sameOwnerRoomQ(BigInt(n - 50), n & 1 ? "long" : "short");
      oiUtilisationBps(BigInt(n), 77n);
    }
  });
});
