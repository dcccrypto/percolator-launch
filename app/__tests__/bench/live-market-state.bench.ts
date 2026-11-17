// @vitest-environment node
import { bench, describe } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { parseLiveState } from "@/lib/live-market-state";
import { liveMarketFixtures } from "../helpers/live-market-slabs";

__setDevnetV22ForTest(true);
const CALLS = 1_000; // per iteration; 10k x 3 fixtures x 5 runs is ~25 min before the fix (stake-pool PDA derive ~3 ms/call)

describe(`parseLiveState x${CALLS}`, () => {
  for (const f of liveMarketFixtures()) {
    bench(
      `${f.name} (${f.data.length} B)`,
      () => {
        for (let n = 0; n < CALLS; n++) parseLiveState(f.data, f.key);
      },
      { time: 0, iterations: 3, warmupIterations: 1 },
    );
  }
});
