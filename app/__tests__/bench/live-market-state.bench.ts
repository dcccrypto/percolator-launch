// @vitest-environment node
import { bench, describe } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { parseLiveState } from "@/lib/live-market-state";
import { liveMarketFixtures } from "../helpers/live-market-slabs";

__setDevnetV22ForTest(true);
const CALLS = 2_000;

describe(`parseLiveState x${CALLS}`, () => {
  for (const f of liveMarketFixtures().slice(0, 1)) {
    bench(
      `${f.name} (${f.data.length} B)`,
      () => {
        for (let n = 0; n < CALLS; n++) parseLiveState(f.data, f.key);
      },
      { time: 0, iterations: 5, warmupIterations: 1 },
    );
  }
});
