import type { PositionPnlInput } from "@/lib/position-pnl";

const ONE = 1_000_000_000_000_000n;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const rint = (lo: number, hi: number) => BigInt(Math.floor(lo + rnd() * (hi - lo)));

export function makePositions(n: number): PositionPnlInput[] {
  const out: PositionPnlInput[] = [];
  for (let i = 0; i < n; i++) {
    const long = rnd() > 0.5;
    const size = rint(1_000_000, 500_000_000_000);
    const entry = rint(50_000_000, 200_000_000);
    out.push({
      basisQ: long ? size : -size,
      aBasis: ONE,
      epochSnap: 1n,
      adlFactors: { aLong: ONE - rint(0, 1000), aShort: ONE, epochLong: 1n, epochShort: 1n, modeLong: 0, modeShort: 0 },
      markE6: entry,
      anchorMarkE6: entry,
      cachedEntryE6: entry,
      cachedRiskEntryE6: i % 3 === 0 ? entry - 10_000n : null,
      onChainPnl: rint(-5_000_000, 5_000_000),
      initialMarginBps: 1000n,
      maintenanceMarginBps: 500n,
      capital: rint(10_000_000, 5_000_000_000),
      activeLegCount: 1,
    });
  }
  return out;
}

