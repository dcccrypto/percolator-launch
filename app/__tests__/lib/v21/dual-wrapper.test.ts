import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const V1 = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const V1_MATCHER = "EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX";
const V21 = {
  wrapper: "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe",
  stake: "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE",
  nft: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs",
  matcher: "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam",
};
const FOREIGN = "11111111111111111111111111111111";

let cfgProgram = V1;
vi.mock("@/lib/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfig: () => ({ ...actual.getConfig(), network: "devnet", programId: cfgProgram }),
  };
});

import { __setMoveFlowForTest } from "@/lib/v21/move/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { acceptedWrapperIds, isAcceptedWrapper, marketWorld } from "@/lib/v21/worlds";
import { dualWorldProgramIds, worldOfWrapper } from "@/lib/v21/world-ids";
import { getAllProgramIds } from "@/lib/config";

function setV21Env(on: boolean): void {
  const keys = { WRAPPER: V21.wrapper, STAKE: V21.stake, NFT: V21.nft, MATCHER: V21.matcher } as const;
  for (const [k, v] of Object.entries(keys)) {
    const name = `NEXT_PUBLIC_V21_${k}_PROGRAM_ID`;
    if (on) process.env[name] = v;
    else delete process.env[name];
  }
}

beforeEach(() => {
  cfgProgram = V1;
  setV21Env(true);
  __setDevnetV21ForTest(true);
});
afterEach(() => {
  __setMoveFlowForTest(null);
  __setDevnetV21ForTest(null);
  setV21Env(false);
});

describe("dual-wrapper reads, flag off (byte-identical to today)", () => {
  it("accepts only the configured wrapper and tags nothing", () => {
    __setMoveFlowForTest(false);
    expect(acceptedWrapperIds()).toEqual([V1]);
    expect(isAcceptedWrapper(V1)).toBe(true);
    expect(isAcceptedWrapper(V21.wrapper)).toBe(false);
    expect(marketWorld(V1)).toBeNull();
    expect(dualWorldProgramIds()).toEqual([]);
  });

  it("after a cutover with the flag off, a v1 slab is rejected exactly as before", () => {
    __setMoveFlowForTest(false);
    cfgProgram = V21.wrapper;
    expect(isAcceptedWrapper(V1)).toBe(false);
    expect(isAcceptedWrapper(V21.wrapper)).toBe(true);
  });

  it("getAllProgramIds adds nothing", () => {
    __setMoveFlowForTest(false);
    const off = getAllProgramIds();
    expect(off).not.toContain(V21.wrapper);
  });
});

describe("dual-wrapper reads, flag on after the v2.1 cutover", () => {
  beforeEach(() => {
    __setMoveFlowForTest(true);
    cfgProgram = V21.wrapper;
  });

  it("a v1 row survives when the configured wrapper is v2.1", () => {
    expect(isAcceptedWrapper(V1)).toBe(true);
    expect(marketWorld(V1)).toBe("v1");
  });

  it("a v2.1 row is visible and tagged v21", () => {
    expect(isAcceptedWrapper(V21.wrapper)).toBe(true);
    expect(marketWorld(V21.wrapper)).toBe("v21");
  });

  it("a foreign program is rejected and untagged", () => {
    expect(isAcceptedWrapper(FOREIGN)).toBe(false);
    expect(marketWorld(FOREIGN)).toBeNull();
    expect(isAcceptedWrapper(undefined)).toBe(false);
    expect(isAcceptedWrapper("")).toBe(false);
  });

  it("scans both wrappers once each", () => {
    expect(acceptedWrapperIds().sort()).toEqual([V1, V21.wrapper].sort());
  });

  it("the slab provider allowlist keeps trusting the v1 matcher and adds the v2.1 ids", () => {
    const ids = getAllProgramIds();
    expect(ids).toContain(V1);
    expect(ids).toContain(V1_MATCHER);
    expect(ids).toContain(V21.wrapper);
    expect(ids).toContain(V21.matcher);
  });

  it("config still on v1 (pre-cutover) with v2.1 ids set: both worlds are accepted", () => {
    cfgProgram = V1;
    expect(acceptedWrapperIds().sort()).toEqual([V1, V21.wrapper].sort());
  });

  it("v2.1 ids that are not configured leave only the v1 world (no phantom v21)", () => {
    setV21Env(false);
    cfgProgram = V1;
    expect(acceptedWrapperIds()).toEqual([V1]);
    expect(worldOfWrapper(V21.wrapper)).toBeNull();
  });

  it("a v2.1 id that collides with a v1 id is refused outright", () => {
    cfgProgram = V1;
    process.env.NEXT_PUBLIC_V21_WRAPPER_PROGRAM_ID = V1;
    expect(worldOfWrapper(V1)).toBe("v1");
    expect(acceptedWrapperIds()).not.toContain(V21.wrapper);
  });
});
