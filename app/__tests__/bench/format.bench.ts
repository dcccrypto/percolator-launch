import { bench, describe } from "vitest";
import * as cur from "@/lib/format";
import * as old from "../fixtures/format.frozen";

// Fixed input set: tiny, normal, huge, negative, null.
const BIG: Array<bigint | null> = [1n, 1_234_567n, 123_456_789_012n, -987_654_321n, null];
const USD_E6: Array<bigint | null> = [1n, 81_166_378n, 999_999_000_000n, -5_000_000n, null];
const NUM: Array<number | null> = [0.000004012, 81.166378, 123456.789, -42.5, null];

function run<T>(fn: (x: T) => string, xs: T[]) {
  return () => {
    for (let i = 0; i < xs.length; i++) fn(xs[i]);
  };
}

const impls = { current: cur, frozen: old } as const;
for (const [name, m] of Object.entries(impls)) {
  describe(name, () => {
    bench("formatTokenAmount", run((x: bigint | null) => m.formatTokenAmount(x, 9), BIG));
    bench("formatUsd", run((x: bigint | null) => m.formatUsd(x), USD_E6));
    bench("formatMarkPrice", run((x: number | null) => m.formatMarkPrice(x), NUM));
    bench("formatPnl", run((x: bigint | null) => m.formatPnl(x, 6), BIG));
    bench("formatUsdFromNumber", run((x: number | null) => m.formatUsdFromNumber(x), NUM));
    bench("formatLiqPrice", run((x: bigint | null) => m.formatLiqPrice(x), USD_E6));
  });
}
