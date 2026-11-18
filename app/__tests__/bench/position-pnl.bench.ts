/**
 * Bench: computePositionPnl for 1,000 positions x 100 price ticks.
 * Run: pnpm exec vitest bench --run --maxWorkers=4 __tests__/bench/position-pnl.bench.ts
 * Reports median ms over 5 iterations (vitest bench `p50`/`median`).
 */
import { bench, describe } from "vitest";
import { computePositionPnl } from "@/lib/position-pnl";
import { makePositions } from "./position-pnl.fixtures";

const positions = makePositions(1000);
const ticks = Array.from({ length: 100 }, (_, t) => 1 + (t - 50) / 2000);

describe("position-pnl", () => {
  bench(
    "computePositionPnl 1000 positions x 100 ticks",
    () => {
      let acc = 0n;
      for (const k of ticks) {
        for (const p of positions) {
          const mark = BigInt(Math.round(Number(p.cachedEntryE6) * k));
          const r = computePositionPnl({ ...p, markE6: mark });
          acc += r.unrealizedPnl ?? 0n;
        }
      }
      return acc;
    },
    { iterations: 5, warmupIterations: 1, time: 0 },
  );
});
