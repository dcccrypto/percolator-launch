import { describe, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { wrapperEventTokensV22 } from "@/lib/v22/sdk/v22-fill-events";
import { fillEventLogs } from "../helpers/fill-event-fixture";

/** Scoped bench: `BENCH=1 npx vitest run __tests__/bench --maxWorkers=4`. Skipped otherwise. */
const wrapper = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const other = new PublicKey("EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX");
const market = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");

function logs22(): string[] {
  const fill = fillEventLogs(wrapper, market, [{ flags: 0, requestedQ: 5n, executedQ: 5n }]);
  const o = other.toBase58();
  const sys = "11111111111111111111111111111111";
  return [
    `Program ComputeBudget111111111111111111111111111111 invoke [1]`, `Program ComputeBudget111111111111111111111111111111 success`,
    `Program ${sys} invoke [1]`, `Program ${sys} success`,
    ...fill.slice(0, 1),
    `Program log: Instruction: Trade`, `Program ${o} invoke [2]`, `Program log: matcher`, `Program ${o} consumed 4000 of 200000 compute units`, `Program ${o} success`,
    fill[1], `Program ${wrapper.toBase58()} consumed 45000 of 200000 compute units`, fill[2],
    `Program ${wrapper.toBase58()} invoke [1]`, `Program log: Instruction: Crank`, `Program ${wrapper.toBase58()} consumed 9000 of 150000 compute units`,
    `Program ${wrapper.toBase58()} success`, `Program ${sys} invoke [1]`, `Program log: x`, `Program ${sys} success`,
    `Program log: done`, `Program log: done2`,
  ];
}

describe.skipIf(!process.env.BENCH)("bench wrapperEventTokensV22", () => {
  it("20,000 calls on a 22-line log", () => {
    const l = logs22();
    for (let i = 0; i < 500; i++) wrapperEventTokensV22(l, wrapper);
    const N = 20000, t0 = performance.now();
    for (let i = 0; i < N; i++) wrapperEventTokensV22(l, wrapper);
    const us = ((performance.now() - t0) * 1000) / N;
    console.log(`BENCH lines=${l.length} calls=${N} us/call=${us.toFixed(1)} ok=${wrapperEventTokensV22(l, wrapper).ok}`);
  }, 300_000);
});
