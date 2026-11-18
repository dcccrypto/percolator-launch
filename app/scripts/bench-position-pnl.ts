// Standalone profile driver: node --cpu-prof --import tsx scripts/bench-position-pnl.ts
import { computePositionPnl } from "../lib/position-pnl";
import { makePositions } from "../__tests__/bench/position-pnl.fixtures";

const positions = makePositions(1000);
const ticks = Array.from({ length: 100 }, (_, t) => 1 + (t - 50) / 2000);
const runs: number[] = [];
for (let r = 0; r < 6; r++) {
  const t0 = performance.now();
  let acc = 0n;
  for (const k of ticks) for (const p of positions) {
    acc += computePositionPnl({ ...p, markE6: BigInt(Math.round(Number(p.cachedEntryE6) * k)) }).unrealizedPnl ?? 0n;
  }
  if (r > 0) runs.push(performance.now() - t0);
  if (r === 0) console.log("checksum", acc);
}
runs.sort((a, b) => a - b);
console.log("median ms", runs[2].toFixed(1), "runs", runs.map((x) => x.toFixed(0)).join(","));
